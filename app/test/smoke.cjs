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

async function prepare() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "deberopa-app-home-"))
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "deberopa-app-proj-"))
  fs.writeFileSync(path.join(project, "hello.txt"), "hello\n")
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
    snapshot: false,
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
        await shot("failure")
      } catch {}
      app.exit(1)
    },
  )
}

module.exports = { prepare, run }
