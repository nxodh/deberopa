import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { applyEvent, newConv, type Conv } from "../app/src/conv"
import { startServer } from "../src/server/server"
import { endProject, mockConfig, reply, startMockLLM, tmpDir, useProject, type MockLLM } from "./helpers"

// The app's main process talks to `deberopa serve` with a small CommonJS client, and its renderer
// keeps each conversation in step with the event stream through `conv.ts`. Both are exercised here
// against the real server and a mock model.
const { DeberopaClient, createSseParser } = require(path.join(import.meta.dir, "..", "app", "lib", "client.cjs"))

let mock: MockLLM
let server: ReturnType<typeof startServer>
let client: any
let dir: string

beforeAll(() => {
  mock = startMockLLM()
  dir = tmpDir()
  fs.writeFileSync(path.join(dir, "a.txt"), "hello")
  useProject(dir, mockConfig(mock, { permission: { edit: "ask" } }))
  server = startServer({ port: 0, password: "app-test-password" })
  client = new DeberopaClient({ baseUrl: `http://127.0.0.1:${server.port}`, password: "app-test-password" })
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

/** Follow the event stream into a conversation, the way the renderer does. */
function follow(sessionID: string) {
  let conv: Conv = newConv(sessionID)
  const types = new Set<string>()
  const abort = new AbortController()
  client
    .events((e: any) => {
      types.add(e.type)
      const next = applyEvent(conv, e)
      if (next && next !== "reload") conv = next
    }, abort.signal)
    .catch(() => {})
  return { get conv() { return conv }, types, stop: () => abort.abort() }
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

test("a prompt streams into the conversation and ends idle", async () => {
  const session = await client.createSession("app")
  const f = follow(session.id)
  expect(await waitFor(() => f.types.has("server.connected"))).toBe(true)

  mock.queue(reply.text("hello from the model"))
  await client.prompt(session.id, "say hi")
  expect(await waitFor(() => f.types.has("session.idle"))).toBe(true)
  f.stop()

  expect(f.conv.messages.map((m) => m.role)).toEqual(["user", "assistant"])
  const text = f.conv.messages[1]!.parts!.find((p) => p.type === "text")!
  expect(text.text).toBe("hello from the model")
  expect(f.conv.busy).toBe(false)
  // the reducer's view matches what a fresh load returns
  const loaded = await client.messages(session.id)
  expect(loaded.map((m: any) => m.id)).toEqual(f.conv.messages.map((m) => m.id))
})

test("a permission request appears and can be answered", async () => {
  const session = await client.createSession("perm")
  const f = follow(session.id)
  expect(await waitFor(() => f.types.has("server.connected"))).toBe(true)

  const target = path.join(dir, "written.txt")
  mock.queue(reply.tools([{ name: "write", args: { filePath: target, content: "from-the-agent" } }]))
  mock.queue(reply.text("done"))
  await client.prompt(session.id, "run it")
  expect(await waitFor(() => f.conv.permissions.length > 0)).toBe(true)
  const asked = f.conv.permissions[0]!
  expect(asked.permission).toBe("edit")
  await client.replyPermission(asked.id, "once")
  expect(await waitFor(() => f.types.has("session.idle") && f.conv.permissions.length === 0)).toBe(true)
  f.stop()

  const tool = f.conv.messages.flatMap((m) => m.parts ?? []).find((p) => p.type === "tool")!
  expect(tool.state.status).toBe("completed")
  expect(fs.readFileSync(target, "utf8")).toBe("from-the-agent")
}, 30_000)

test("unknown ids fail cleanly", async () => {
  await expect(client.messages("ses_missing")).rejects.toMatchObject({ status: 404 })
  await expect(client.replyPermission("per_missing", "once")).rejects.toMatchObject({ status: 404 })
})

test("agent and model choices are accepted by the prompt route", async () => {
  const session = await client.createSession("choices")
  const f = follow(session.id)
  expect(await waitFor(() => f.types.has("server.connected"))).toBe(true)
  const providers = await client.providers()
  const model = Object.values(providers.providers.find((p: any) => p.id === "mock").models)[0] as any
  const agents = await client.agents()
  expect(agents.some((a: any) => a.name === "build")).toBe(true)

  mock.queue(reply.text("chosen"))
  await client.prompt(session.id, "pick", { model: `mock/${model.id}`, agent: "build" })
  expect(await waitFor(() => f.types.has("session.idle"))).toBe(true)
  f.stop()
  expect(f.conv.messages[1]!.parts!.find((p) => p.type === "text")!.text).toBe("chosen")
})
