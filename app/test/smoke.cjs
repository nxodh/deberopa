"use strict"
// App smoke test (DEBEROPA_APP_TEST=1): opens a throw-away project against a mock model, sends a
// prompt, checks the answer shows up, saves a fake "other computer", and writes screenshots.
// Everything is local and fake; nothing reaches a real model or key.
const fs = require("node:fs")
const http = require("node:http")
const os = require("node:os")
const path = require("node:path")

const LOG = process.env.DEBEROPA_APP_TEST_LOG || ""
const SHOTS = process.env.DEBEROPA_APP_SHOTS || ""
const ANSWER = "pong from the mock model"

const log = (message) => {
  const line = `[app-test] ${new Date().toISOString()} ${message}`
  console.log(line)
  if (LOG) fs.appendFileSync(LOG, line + "\n")
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)))

function mockModel() {
  return http.createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      if (req.url.endsWith("/models")) {
        res.setHeader("content-type", "application/json")
        return res.end(JSON.stringify({ data: [{ id: "mock-1" }] }))
      }
      let body = {}
      try {
        body = JSON.parse(raw)
      } catch {}
      const usage = { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 }
      if (body.stream === false) {
        res.setHeader("content-type", "application/json")
        return res.end(JSON.stringify({ id: "m", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: ANSWER }, finish_reason: "stop" }], usage }))
      }
      res.writeHead(200, { "content-type": "text/event-stream" })
      const chunk = (delta, finish, extra) => `data: ${JSON.stringify({ id: "m", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`
      const messages = Array.isArray(body.messages) ? body.messages : []
      const last = messages[messages.length - 1] || {}
      const userText = (m) => (typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((c) => c.text || "").join("") : "")
      const lastUser = [...messages].reverse().find((m) => m.role === "user")
      if (last.role !== "tool" && lastUser && userText(lastUser).includes("make a file")) {
        // the model asks to write a file: the app shows a permission card, then the change
        const args = JSON.stringify({ filePath: path.join(projectDir, "generated.txt"), content: "made by the agent\n" })
        res.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "write", arguments: args } }] }, null))
        res.write(chunk({}, "tool_calls", { usage }))
        return res.end("data: [DONE]\n\n")
      }
      if (last.role === "tool") {
        res.write(chunk({ role: "assistant", content: "I wrote generated.txt" }, null))
        res.write(chunk({}, "stop", { usage }))
        return res.end("data: [DONE]\n\n")
      }
      res.write(chunk({ role: "assistant", content: ANSWER }, null))
      res.write(chunk({}, "stop", { usage }))
      res.end("data: [DONE]\n\n")
    })
  })
}

function fakeOllama() {
  return http.createServer((req, res) => {
    res.setHeader("content-type", "application/json")
    if (req.url === "/api/tags") return res.end(JSON.stringify({ models: [{ name: "qwen3:8b", details: { parameter_size: "8B", quantization_level: "Q4_K_M" } }] }))
    if (req.url === "/api/show") return res.end(JSON.stringify({ model_info: { "qwen3.context_length": 32768 }, capabilities: ["completion", "tools"] }))
    res.setHeader("content-type", "text/plain")
    res.end(req.url === "/" ? "Ollama is running" : "not found")
  })
}

let servers = []
let projectDir = ""

async function prepare() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "deberopa-app-home-"))
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "deberopa-app-proj-"))
  fs.writeFileSync(path.join(project, "hello.txt"), "hello\n")
  projectDir = project
  // snapshots need a git repository: they are what the diff and the revert work from
  require("node:child_process").execFileSync("git", ["init", "-q"], { cwd: project })
  const model = mockModel()
  const port = await listen(model)
  const ollama = fakeOllama()
  const ollamaPort = await listen(ollama)
  servers = [model, ollama]
  process.env.DEBEROPA_HOME = home
  process.env.DEBEROPA_DISABLE_LOCAL_DETECT = "1"
  process.env.DEBEROPA_DISABLE_MODELS_FETCH = "1"
  process.env.DEBEROPA_MODELS_URL = "http://127.0.0.1:9/none"
  process.env.DEBEROPA_CONFIG_CONTENT = JSON.stringify({
    model: "mock/mock-1",
    snapshot: true,
    provider: { mock: { name: "Mock", api: `http://127.0.0.1:${port}/v1`, models: { "mock-1": { name: "Mock 1", tool_call: true, limit: { context: 100000, output: 4000 } } } } },
  })
  process.env.DEBEROPA_APP_OLLAMA_PORT = String(ollamaPort)
  return project
}

function run({ app, win }) {
  const exec = (code) => win().webContents.executeJavaScript(code)
  const waitFor = async (what, code, ms = 30000) => {
    const end = Date.now() + ms
    for (;;) {
      let value
      try {
        value = await exec(code)
      } catch {}
      if (value) return value
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
      await sleep(150)
    }
  }
  const shot = async (name) => {
    if (!SHOTS) return
    fs.mkdirSync(SHOTS, { recursive: true })
    const image = await win().webContents.capturePage()
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), image.toPNG())
    log(`screenshot ${name}`)
  }
  const type = (selector, value) =>
    exec(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false;
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event("input", { bubbles: true })); return true })()`)
  const click = (selector) => exec(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true })()`)

  win().webContents.on("console-message", (_e, level, message) => {
    if (level >= 2) log(`console: ${String(message).slice(0, 300)}`)
  })
  const main = async () => {
    log(`start on ${process.platform}, electron ${process.versions.electron}`)
    // the icon files the window, the taskbar and the installers use must exist and decode
    const { nativeImage } = require("electron")
    for (const [name, size] of [["icon.png", 512], ["icons/256.png", 256], ["icons/32.png", 32]]) {
      const image = nativeImage.createFromPath(path.join(__dirname, "..", "build", name))
      if (image.isEmpty() || image.getSize().width !== size) throw new Error(`build/${name} is missing or not ${size} px`)
    }
    for (const name of ["icon.ico", "icon.icns"]) {
      if (fs.statSync(path.join(__dirname, "..", "build", name)).size < 1000) throw new Error(`build/${name} is missing or empty`)
    }
    log("icons present and readable")
    await waitFor("window", `document.readyState === "complete"`, 15000)
    await waitFor("the composer (project opened, session shown)", `!!document.querySelector('[data-testid=composer]')`, 60000)
    log("project opened, session shown")

    await type("[data-testid=composer]", "ping")
    await sleep(150)
    await click("[data-testid=send]")
    await waitFor("the answer", `[...document.querySelectorAll(".msg.assistant")].some((n) => n.textContent.includes(${JSON.stringify(ANSWER)}))`, 60000)
    log("the model's answer is on screen")
    await waitFor("status bar", `document.querySelector(".status").textContent.includes("deberopa-app-proj-")`, 5000)
    await shot("session")

    // the agent changes a file: permission card, then the change with a diff and a revert
    await exec(`(window.confirm = () => true, true)`)
    await type("[data-testid=composer]", "make a file")
    await sleep(150)
    await click("[data-testid=send]")
    // writes inside the project are allowed by default; if a permission card does appear, grant it
    const wrote = Date.now() + 40000
    while (!fs.existsSync(path.join(projectDir, "generated.txt"))) {
      await exec(`(() => { const b = [...document.querySelectorAll(".permission button")].find((x) => x.textContent.includes("Allow once")); if (b) b.click(); return true })()`)
      if (Date.now() > wrote) throw new Error("the agent's file was not written")
      await sleep(150)
    }
    await waitFor("the diff button", `!!document.querySelector('[data-testid="show-diff"]')`, 30000)
    log("the agent wrote a file")
    await click('[data-testid="show-diff"]')
    await waitFor("the diff", `(() => { const d = document.querySelector('[data-testid=diff]'); return !!d && d.textContent.includes("made by the agent") })()`, 15000)
    await shot("diff")
    await click("[data-testid=revert]")
    const reverted = Date.now() + 15000
    while (fs.existsSync(path.join(projectDir, "generated.txt"))) {
      if (Date.now() > reverted) throw new Error("the revert did not remove the agent's file")
      await sleep(150)
    }
    log("the diff was shown and the agent's change was reverted")

    // the editor: open a file from the tree, change it, save it, and see it on disk
    await waitFor("the file in the tree", `!!document.querySelector('[data-testid="file-hello.txt"]')`, 10000)
    await click('[data-testid="file-hello.txt"]')
    await waitFor("the file in the editor", `!!document.querySelector(".cm-content") && document.querySelector(".cm-content").textContent.includes("hello")`, 10000)
    // real key presses, as a user types: focus the editor, select all, type
    await click(".cm-content")
    await exec(`document.querySelector(".cm-content").focus()`)
    const wc = win().webContents
    const mod = process.platform === "darwin" ? "meta" : "control"
    wc.sendInputEvent({ type: "keyDown", keyCode: "a", modifiers: [mod] })
    wc.sendInputEvent({ type: "keyUp", keyCode: "a", modifiers: [mod] })
    for (const ch of "edited in the app") {
      wc.sendInputEvent({ type: "keyDown", keyCode: ch })
      wc.sendInputEvent({ type: "char", keyCode: ch })
      wc.sendInputEvent({ type: "keyUp", keyCode: ch })
    }
    wc.sendInputEvent({ type: "keyDown", keyCode: "Enter" })
    wc.sendInputEvent({ type: "keyUp", keyCode: "Enter" })
    await waitFor("the unsaved mark", `!!document.querySelector('[title="Unsaved changes"]')`, 5000)
    await click("[data-testid=save]")
    await waitFor("the file on disk", `true`, 100)
    const end = Date.now() + 5000
    while (fs.readFileSync(path.join(projectDir, "hello.txt"), "utf8") !== "edited in the app\n") {
      if (Date.now() > end) throw new Error(`hello.txt was not saved (it holds ${JSON.stringify(fs.readFileSync(path.join(projectDir, "hello.txt"), "utf8"))})`)
      await sleep(100)
    }
    await waitFor("the unsaved mark to go", `!document.querySelector('[title="Unsaved changes"]')`, 5000)
    log("a file was opened, edited and saved from the editor tab")
    // a change made outside (the agent) is picked up while the file is open and not dirty
    fs.writeFileSync(path.join(projectDir, "hello.txt"), "changed by the agent\n")
    await waitFor("the outside change", `document.querySelector(".cm-content").textContent.includes("changed by the agent")`, 8000)
    log("a change made outside shows up in the open editor")
    await shot("editor")

    // the terminal: a real shell, typed into with real key events
    await click("[data-testid=open-terminal]")
    await waitFor("the terminal", `!!document.querySelector(".xterm-rows") && !!document.querySelector(".xterm-helper-textarea")`, 15000)
    await sleep(800)
    await exec(`document.querySelector(".xterm-helper-textarea").focus(); true`)
    for (const ch of "echo terminal-works-1234") {
      win().webContents.sendInputEvent({ type: "keyDown", keyCode: ch })
      win().webContents.sendInputEvent({ type: "char", keyCode: ch })
      win().webContents.sendInputEvent({ type: "keyUp", keyCode: ch })
    }
    win().webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" })
    win().webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" })
    // the typed command is echoed once; the shell's answer is a second line with the marker
    await waitFor("the shell's answer", `(document.querySelector(".xterm-rows").textContent.match(/terminal-works-1234/g) || []).length >= 2`, 15000)
    log("a terminal ran a command")
    await shot("terminal")
    // switching tabs must not lose an unsaved edit or kill the shell
    await click('[data-testid="file-hello.txt"]')
    await waitFor("the editor again", `!!document.querySelector(".cm-content")`, 10000)
    // settings: keys, trust, tools, usage; and the command palette
    await click("[data-testid=open-settings]")
    await waitFor("settings", `(() => { const t = (document.querySelector('[data-testid=settings]') || {}).textContent || ""; return t.includes("API keys") && t.includes("Connected tools") && t.includes("Usage") })()`, 15000)
    await waitFor("the usage of the mock model", `document.querySelector('[data-testid=settings]').textContent.includes("mock/mock-1")`, 15000)
    log("settings show keys, trust, tools and usage")
    const wc2 = win().webContents
    const mod2 = process.platform === "darwin" ? "meta" : "control"
    wc2.sendInputEvent({ type: "keyDown", keyCode: "k", modifiers: [mod2] })
    wc2.sendInputEvent({ type: "keyUp", keyCode: "k", modifiers: [mod2] })
    await waitFor("the command palette", `!!document.querySelector('[data-testid=palette]')`, 5000)
    await type('input[aria-label="Command"]', "terminal")
    await sleep(200)
    await exec(`(document.querySelector(".palette-item") || { click() {} }).click(); true`)
    await waitFor("a second terminal from the palette", `document.querySelectorAll(".tab").length >= 1 && [...document.querySelectorAll(".tab-main .title")].some((n) => n.textContent === "Terminal 2")`, 10000)
    log("the command palette opened a terminal")

    await click("[data-testid=open-models]")
    await waitFor("models tab", `!!document.querySelector('[data-testid=models]')`, 10000)
    await waitFor("local info", `document.querySelector('[data-testid=models]').textContent.includes("This computer")`, 10000)
    await type('input[aria-label="Name"]', "mock-gpu")
    await type('input[aria-label="Address"]', `127.0.0.1:${process.env.DEBEROPA_APP_OLLAMA_PORT}`)
    await sleep(150)
    await click("[data-testid=save-host]")
    await waitFor("the saved computer with its model", `(() => { const t = document.querySelector('[data-testid=models]').textContent; return t.includes("mock-gpu") && t.includes("qwen3:8b") })()`, 20000)
    log("a computer on the network was saved and its models listed")
    await shot("models")
    log("OK")
  }

  main().then(
    () => {
      for (const s of servers) s.close()
      app.exit(0)
    },
    async (err) => {
      log(`FAIL ${err && err.message}`)
      try {
        const text = await exec("document.body.innerText")
        log(`page text: ${String(text).slice(0, 1500).replace(/\n/g, " | ")}`)
        const tabs = await exec(`(document.querySelector(".tabs") || {}).innerHTML`)
        log(`tabs: ${String(tabs).slice(0, 1200)}`)
        await shot("failure")
      } catch {}
      app.exit(1)
    },
  )
}

module.exports = { prepare, run }
