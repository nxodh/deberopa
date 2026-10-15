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
