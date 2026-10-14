import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { startServer } from "../src/server/server"
import { endProject, mockConfig, reply, startMockLLM, tmpDir, useProject, type MockLLM } from "./helpers"

// The Deberopa Desktop agent extension is plain CommonJS; its client, state reducer and server supervisor
// have no dependency on VS Code, so they are exercised here against the real server and a mock model.
const root = path.join(import.meta.dir, "..", "desktop", "extensions", "deberopa-agent")
const { DeberopaClient, createSseParser } = require(path.join(root, "lib", "client.js"))
const { createState, applyEvent } = require(path.join(root, "lib", "store.js"))
const { resolveCommand, startServer: spawnServer } = require(path.join(root, "lib", "server.js"))

let mock: MockLLM
let server: ReturnType<typeof startServer>
let client: any
let dir: string

beforeAll(() => {
  mock = startMockLLM()
  dir = tmpDir()
  fs.writeFileSync(path.join(dir, "a.txt"), "hello")
  useProject(dir, mockConfig(mock, { permission: { edit: "ask" }, provider: { mock: { name: "Mock", api: mock.url, options: { apiKey: "sk-test-not-a-real-key-000000000000" }, models: { "mock-1": { name: "Mock 1", tool_call: true } } } } }))
  server = startServer({ port: 0, password: "desktop-test-password" })
  client = new DeberopaClient({ baseUrl: `http://127.0.0.1:${server.port}`, password: "desktop-test-password" })
})
afterAll(() => {
  server.stop(true)
  mock.stop()
  endProject()
})

const waitFor = async (fn: () => boolean, ms = 8000) => {
  const end = Date.now() + ms
  while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 25))
  return fn()
}

test("the SSE parser handles split chunks, comments and bad payloads", () => {
  const seen: any[] = []
  const feed = createSseParser((e: unknown) => seen.push(e))
  feed(': ping\n\ndata: {"type":"a"}\n\nda')
  feed('ta: {"type":"b","properties":{"x":1}}\r\n\r\ndata: not json\n\n')
  expect(seen).toEqual([{ type: "a" }, { type: "b", properties: { x: 1 } }])
})

test("the password is required and the client sends it", async () => {
  const anonymous = await fetch(`http://127.0.0.1:${server.port}/health`)
  expect(anonymous.status).toBe(401)
  expect((await client.health()).ok).toBe(true)
  const wrong = new DeberopaClient({ baseUrl: `http://127.0.0.1:${server.port}`, password: "nope" })
  await expect(wrong.health()).rejects.toThrow()
})

test("a prompt streams into the conversation state and ends idle", async () => {
  const session = await client.createSession("desktop")
  const state = createState()
  state.sessionID = session.id
  const abort = new AbortController()
  const types = new Set<string>()
  client.events((e: any) => {
    types.add(e.type)
    applyEvent(state, e)
  }, abort.signal).catch(() => {})
  expect(await waitFor(() => types.has("server.connected"))).toBe(true)

  mock.queue(reply.text("hello from the model"))
  await client.prompt(session.id, "say hi")
  expect(await waitFor(() => types.has("session.idle"))).toBe(true)
  abort.abort()

  const roles = state.messages.map((m: any) => m.role)
  expect(roles).toEqual(["user", "assistant"])
  const assistant = state.messages[1]
  expect(assistant.parts.find((p: any) => p.type === "text").text).toBe("hello from the model")
  expect(state.busy).toBe(false)
  // the reducer's view matches what a fresh load returns
  const loaded = await client.messages(session.id)
  expect(loaded.map((m: any) => m.id)).toEqual(state.messages.map((m: any) => m.id))
})

test("a permission request appears in the state and can be answered", async () => {
  const session = await client.createSession("perm")
  const state = createState()
  state.sessionID = session.id
  const abort = new AbortController()
  const types = new Set<string>()
  client.events((e: any) => {
    types.add(e.type)
    applyEvent(state, e)
  }, abort.signal).catch(() => {})
  expect(await waitFor(() => types.has("server.connected"))).toBe(true)

  const target = path.join(dir, "written.txt")
  mock.queue(reply.tools([{ name: "write", args: { filePath: target, content: "from-the-agent" } }]))
  mock.queue(reply.text("done"))
  await client.prompt(session.id, "run it")
  expect(await waitFor(() => state.permissions.length > 0)).toBe(true)
  const asked = state.permissions[0]
  expect(asked.permission).toBe("edit")
  await client.replyPermission(asked.id, "once")
  expect(await waitFor(() => types.has("session.idle") && state.permissions.length === 0)).toBe(true)
  abort.abort()

  const tool = state.messages.flatMap((m: any) => m.parts).find((p: any) => p.type === "tool")
  expect(tool.state.status).toBe("completed")
  expect(fs.readFileSync(target, "utf8")).toBe("from-the-agent")
}, 30_000)

test("abort and unknown ids fail cleanly", async () => {
  await expect(client.messages("ses_missing")).rejects.toMatchObject({ status: 404 })
  await expect(client.replyPermission("per_missing", "once")).rejects.toMatchObject({ status: 404 })
})

test("the supervisor starts a real server, reports its address and stops it", async () => {
  const handle = await spawnServer({
    command: process.execPath,
    prefixArgs: ["run", path.join(import.meta.dir, "..", "src", "index.ts")],
    directory: dir,
    timeoutMs: 60_000,
  })
  try {
    expect(handle.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const spawned = new DeberopaClient({ baseUrl: handle.baseUrl, password: handle.password })
    expect((await spawned.health()).ok).toBe(true)
    expect((await spawned.project()).directory).toBe(fs.realpathSync(dir))
    expect((await fetch(handle.baseUrl + "/health")).status).toBe(401)
  } finally {
    handle.stop()
  }
  expect(await Promise.race([handle.exited, new Promise((r) => setTimeout(() => r("timeout"), 10_000))])).not.toBe("timeout")
}, 90_000)

test("a missing executable is reported, not hung", async () => {
  await expect(spawnServer({ command: path.join(dir, "no-such-deberopa"), directory: dir, timeoutMs: 5000 })).rejects.toThrow(/Could not start/)
})

test("command resolution prefers the setting, then the bundled copy, then PATH", () => {
  const app = path.join(dir, "app", "resources", "app")
  fs.mkdirSync(path.join(app, "..", "deberopa"), { recursive: true })
  const bundled = path.join(app, "..", "deberopa", process.platform === "win32" ? "deberopa.exe" : "deberopa")
  expect(resolveCommand({ configured: "/opt/x/deberopa", appRoot: app })).toBe("/opt/x/deberopa")
  expect(resolveCommand({ configured: "  ", appRoot: app })).toBe("deberopa")
  fs.writeFileSync(bundled, "")
  expect(resolveCommand({ configured: "", appRoot: app })).toBe(bundled)
})

test("agent and model choices from the pickers are accepted by the prompt route", async () => {
  const agents = await client.agents()
  expect(agents.some((a: any) => a.name === "plan" && a.mode === "primary")).toBe(true)
  const providers = await client.providers()
  expect(providers.providers.find((p: any) => p.id === "mock").connected).toBe(true)
  const session = await client.createSession("choices")
  const state = createState()
  state.sessionID = session.id
  const abort = new AbortController()
  const types = new Set<string>()
  client.events((e: any) => {
    types.add(e.type)
    applyEvent(state, e)
  }, abort.signal).catch(() => {})
  expect(await waitFor(() => types.has("server.connected"))).toBe(true)
  mock.queue(reply.text("planned"))
  await client.prompt(session.id, "plan it", { agent: "plan", model: "mock/mock-1" })
  expect(await waitFor(() => types.has("session.idle"))).toBe(true)
  abort.abort()
  const assistant = state.messages.find((m: any) => m.role === "assistant")
  expect(assistant.agent).toBe("plan")
  expect(assistant.modelID).toBe("mock-1")
  await expect(client.prompt(session.id, "x", { model: "no-slash" })).rejects.toMatchObject({ status: 400 })
}, 30_000)

test("tool check, slots and model downloads reach the client and the conversation state", async () => {
  const ollama = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/api/chat") return Response.json({ message: { role: "assistant", content: "", tool_calls: [{ function: { name: "get_time", arguments: { city: "Seoul" } } }] } })
      if (url.pathname === "/api/pull") {
        const lines = [{ status: "pulling manifest" }, { status: "pulling abc", total: 10, completed: 5 }, { status: "success" }]
        return new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
      }
      if (url.pathname === "/slots") return Response.json([{ id: 0, n_ctx: 4096, is_processing: true }])
      return new Response("nope", { status: 404 })
    },
  })
  const dir2 = tmpDir()
  useProject(dir2, { model: "fo/m", snapshot: false, provider: { fo: { name: "Fake", protocol: "ollama", api: `http://127.0.0.1:${ollama.port}`, models: { m: { name: "M", tool_call: true, limit: { context: 8192, output: 1000 } } } } } })
  const local = startServer({ port: 0 })
  try {
    const c = new DeberopaClient({ baseUrl: `http://127.0.0.1:${local.port}` })
    expect((await c.toolcheck("fo/m")).status).toBe("ok")
    expect((await c.slots("fo")).slots).toEqual({ total: 1, busy: 1, ctxPerSlot: 4096 })
    const state = createState()
    const abort = new AbortController()
    const types = new Set<string>()
    c.events((e: any) => {
      types.add(e.type)
      applyEvent(state, e)
    }, abort.signal).catch(() => {})
    expect(await waitFor(() => types.has("server.connected"))).toBe(true)
    await c.pull("fo", "qwen3:8b")
    expect(await waitFor(() => state.pulls["fo/qwen3:8b"]?.done === true)).toBe(true)
    abort.abort()
    expect(state.pulls["fo/qwen3:8b"].status).toBe("success")
    await expect(c.pull("fo", "bad name")).rejects.toMatchObject({ status: 400 })
  } finally {
    local.stop(true)
    ollama.stop(true)
    useProject(dir, { permission: { edit: "ask" }, model: "mock/mock-1", snapshot: false, provider: { mock: { name: "Mock", api: mock.url, options: { apiKey: "sk-test-not-a-real-key-000000000000" }, models: { "mock-1": { name: "Mock 1", tool_call: true } } } } })
  }
}, 30_000)
