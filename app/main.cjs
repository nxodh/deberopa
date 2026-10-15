"use strict"
// Deberopa Desktop, main process. One `deberopa serve` per open project; the window talks to them
// only through this process (no CORS, no ports exposed to the page, keys never reach the renderer).
const { app, BrowserWindow, dialog, ipcMain, shell, Menu, nativeImage } = require("electron")
const path = require("node:path")
const fs = require("node:fs")
const cp = require("node:child_process")
const { DeberopaClient } = require("./lib/client.cjs")

const TEST = process.env.DEBEROPA_APP_TEST || ""
/** Test mode only: the folder the window opens by itself. */
let testProject = ""

/** dir -> { dir, proc, client, abort, ready: Promise } */
const projects = new Map()
let win = null

function backend() {
  if (process.env.DEBEROPA_BIN) return { cmd: process.env.DEBEROPA_BIN, args: [] }
  if (app.isPackaged) {
    const exe = process.platform === "win32" ? "deberopa.exe" : "deberopa"
    return { cmd: path.join(process.resourcesPath, "bin", exe), args: [] }
  }
  // development: run the CLI from source with the repository's own Bun
  const root = path.resolve(__dirname, "..")
  // the `bun` package keeps its binary at bin/bun.exe on every platform
  const bun = path.join(root, "node_modules", "bun", "bin", "bun.exe")
  return { cmd: bun, args: ["run", path.join(root, "src", "index.ts")] }
}

const send = (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function start(dir) {
  const entry = { dir, proc: undefined, client: undefined, abort: new AbortController(), ready: undefined }
  entry.ready = new Promise((resolve, reject) => {
    const { cmd, args } = backend()
    let stderr = ""
    let settled = false
    const proc = cp.spawn(cmd, [...args, "serve", "--port", "0", "--dir", dir], { cwd: dir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    entry.proc = proc
    const fail = (message) => {
      if (settled) return
      settled = true
      reject(new Error(message))
    }
    const timer = setTimeout(() => {
      fail("The agent did not start within 30 seconds.")
      proc.kill()
    }, 30_000)
    let out = ""
    proc.stdout.on("data", (chunk) => {
      out += chunk.toString()
      const match = /listening on (http:\/\/[^\s]+)/.exec(out)
      if (match && !settled) {
        settled = true
        clearTimeout(timer)
        entry.client = new DeberopaClient({ baseUrl: match[1], password: process.env.DEBEROPA_SERVER_PASSWORD || undefined })
        pump(entry)
        resolve(entry)
      }
    })
    proc.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-2000)
    })
    proc.on("error", (err) => fail(`Could not start ${cmd}: ${err.message}`))
    proc.on("exit", (code) => {
      clearTimeout(timer)
      entry.abort.abort()
      projects.delete(dir)
      fail(`The agent stopped (exit ${code}). ${stderr.trim()}`)
      send("project:exited", { dir, code })
    })
  })
  projects.set(dir, entry)
  entry.ready.catch(() => projects.delete(dir))
  return entry
}

/** Forward the server's event stream; reconnect when it drops. */
async function pump(entry) {
  while (!entry.abort.signal.aborted) {
    try {
      await entry.client.events((event) => send("event", { dir: entry.dir, event }), entry.abort.signal)
    } catch {
      if (entry.abort.signal.aborted) return
    }
    await sleep(1000)
  }
}

function stop(dir) {
  const entry = projects.get(dir)
  if (!entry) return
  entry.abort.abort()
  try {
    entry.proc.kill()
  } catch {}
  projects.delete(dir)
}

// ---- recent projects ------------------------------------------------------------------------------
const recentsFile = () => path.join(app.getPath("userData"), "recents.json")
function readRecents() {
  try {
    const list = JSON.parse(fs.readFileSync(recentsFile(), "utf8"))
    return Array.isArray(list) ? list.filter((d) => typeof d === "string") : []
  } catch {
    return []
  }
}
function remember(dir) {
  const list = [dir, ...readRecents().filter((d) => d !== dir)].slice(0, 12)
  try {
    fs.mkdirSync(path.dirname(recentsFile()), { recursive: true })
    fs.writeFileSync(recentsFile(), JSON.stringify(list))
  } catch {}
}

// ---- IPC ----------------------------------------------------------------------------------------
ipcMain.handle("app:info", () => ({ version: app.getVersion(), platform: process.platform, recents: TEST ? [] : readRecents(), testProject }))

ipcMain.handle("project:open", async (_e, requested) => {
  let dir = typeof requested === "string" ? requested : undefined
  if (!dir) {
    const picked = await dialog.showOpenDialog(win, { title: "Open a project folder", properties: ["openDirectory", "createDirectory"] })
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true }
    dir = picked.filePaths[0]
  }
  dir = path.resolve(dir)
  try {
    if (!fs.statSync(dir).isDirectory()) return { ok: false, error: `${dir} is not a folder.` }
  } catch {
    return { ok: false, error: `${dir} does not exist.` }
  }
  try {
    await (projects.get(dir) ?? start(dir)).ready
  } catch (err) {
    return { ok: false, error: err.message }
  }
  remember(dir)
  return { ok: true, dir, name: path.basename(dir) || dir }
})

ipcMain.handle("project:close", (_e, dir) => stop(dir))

ipcMain.handle("api", async (_e, req) => {
  const entry = projects.get(req && req.dir)
  if (!entry || !entry.client) return { ok: false, status: 0, error: "That project is not open." }
  if (typeof req.path !== "string" || !req.path.startsWith("/")) return { ok: false, status: 0, error: "Bad request." }
  try {
    return { ok: true, data: await entry.client.request(req.method || "GET", req.path, req.body) }
  } catch (err) {
    return { ok: false, status: err.status || 0, error: err.message }
  }
})

// ---- files (the editor) -----------------------------------------------------------------------------
const MAX_TEXT = 2 * 1024 * 1024

/** `rel` inside the project folder, symlinks resolved; undefined when it would leave the folder. */
function inside(dir, rel) {
  if (typeof rel !== "string" || rel.includes("\0")) return undefined
  let root
  try {
    root = fs.realpathSync(dir)
  } catch {
    return undefined
  }
  const target = path.resolve(root, rel)
  let real
  try {
    real = fs.realpathSync(target)
  } catch {
    // a file that does not exist yet: its folder must be inside
    try {
      real = path.join(fs.realpathSync(path.dirname(target)), path.basename(target))
    } catch {
      return undefined
    }
  }
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep
  return real === root || real.startsWith(rootWithSep) ? { root, real } : undefined
}

const known = (dir) => projects.has(dir)

ipcMain.handle("fs:list", (_e, req) => {
  if (!known(req && req.dir)) return { ok: false, error: "That project is not open." }
  const at = inside(req.dir, req.rel || ".")
  if (!at) return { ok: false, error: "Outside the project folder." }
  try {
    const entries = fs
      .readdirSync(at.real, { withFileTypes: true })
      .filter((d) => d.name !== ".git")
      .slice(0, 5000)
      .map((d) => ({ name: d.name, dir: d.isDirectory() || (d.isSymbolicLink() && safeIsDir(path.join(at.real, d.name))) }))
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
    return { ok: true, entries }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

function safeIsDir(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

ipcMain.handle("fs:read", (_e, req) => {
  if (!known(req && req.dir)) return { ok: false, error: "That project is not open." }
  const at = inside(req.dir, req.rel)
  if (!at) return { ok: false, error: "Outside the project folder." }
  try {
    const stat = fs.statSync(at.real)
    if (!stat.isFile()) return { ok: false, error: "Not a file." }
    if (stat.size > MAX_TEXT) return { ok: false, error: `Too large to edit here (${Math.round(stat.size / 1024)} KB; the limit is ${MAX_TEXT / 1024} KB).` }
    const buffer = fs.readFileSync(at.real)
    if (buffer.includes(0)) return { ok: false, error: "This looks like a binary file." }
    return { ok: true, text: buffer.toString("utf8"), mtimeMs: stat.mtimeMs, size: stat.size }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle("fs:stat", (_e, req) => {
  if (!known(req && req.dir)) return { ok: false }
  const at = inside(req.dir, req.rel)
  if (!at) return { ok: false }
  try {
    const stat = fs.statSync(at.real)
    return { ok: true, mtimeMs: stat.mtimeMs, size: stat.size }
  } catch {
    return { ok: false, missing: true }
  }
})

ipcMain.handle("fs:write", (_e, req) => {
  if (!known(req && req.dir)) return { ok: false, error: "That project is not open." }
  if (typeof req.text !== "string") return { ok: false, error: "Nothing to write." }
  const at = inside(req.dir, req.rel)
  if (!at) return { ok: false, error: "Outside the project folder." }
  try {
    // the agent may have changed the file since it was read: do not overwrite that without being told to
    if (!req.force && typeof req.expectedMtimeMs === "number" && fs.existsSync(at.real)) {
      const current = fs.statSync(at.real)
      // timestamps can be coarse (the same tick for two writes): the size is compared as well
      const moved = Math.abs(current.mtimeMs - req.expectedMtimeMs) > 1 || (typeof req.expectedSize === "number" && current.size !== req.expectedSize)
      if (moved) return { ok: false, conflict: true, error: "The file changed on disk since you opened it." }
    }
    fs.writeFileSync(at.real, req.text)
    const written = fs.statSync(at.real)
    return { ok: true, mtimeMs: written.mtimeMs, size: written.size }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle("open-external", (_e, url) => {
  if (typeof url === "string" && /^https?:\/\//.test(url)) return shell.openExternal(url)
})

// ---- window -------------------------------------------------------------------------------------
/** build/icon.png is the 512 px icon; installers use icon.ico (Windows) and icon.icns (macOS). */
const ICON = path.join(__dirname, "build", "icon.png")

function createWindow() {
  win = new BrowserWindow({
    // taskbar / window icon on Windows and Linux (a packaged app also embeds icon.ico in the .exe)
    icon: ICON,
    width: 1360,
    height: 860,
    minWidth: 760,
    minHeight: 480,
    title: "Deberopa",
    show: !TEST || process.env.DEBEROPA_APP_SHOW === "1",
    backgroundColor: "#ffffff",
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: "deny" }
  })
  win.webContents.on("will-navigate", (event) => event.preventDefault())
  win.loadFile(path.join(__dirname, "dist", "index.html"))
}

app.setName("Deberopa")
if (process.platform === "linux") app.setDesktopName("deberopa.desktop")

app.whenReady().then(async () => {
  if (process.platform !== "darwin") Menu.setApplicationMenu(null)
  // macOS shows the Dock icon of the running binary; a development run is Electron's, so set ours
  if (process.platform === "darwin" && app.dock) app.dock.setIcon(nativeImage.createFromPath(path.join(__dirname, "build", "icons", "1024.png")))
  const smoke = TEST ? require("./test/smoke.cjs") : undefined
  if (smoke) testProject = await smoke.prepare()
  createWindow()
  if (smoke) smoke.run({ app, win: () => win })
})

app.on("window-all-closed", () => app.quit())
app.on("before-quit", () => {
  for (const dir of [...projects.keys()]) stop(dir)
})
