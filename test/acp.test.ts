import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { PassThrough } from "node:stream"
import { pathToFileURL } from "node:url"
import { fromContentBlocks, serveAcp } from "../src/acp/server"
import { endProject, mockConfig, reply, startMockLLM, tmpDir, useProject, type MockLLM } from "./helpers"

let mock: MockLLM
let dir: string

beforeAll(() => {
  mock = startMockLLM()
})
afterAll(() => {
  mock.stop()
  endProject()
})
beforeEach(() => {
  dir = tmpDir()
  mock.reset()
  useProject(dir, mockConfig(mock, { permission: { edit: "ask" } }))
})

/** A scripted editor on the other end of the pipes. */
function connect() {
  const toAgent = new PassThrough()
  const fromAgent = new PassThrough()
  const done = serveAcp({ input: toAgent, output: fromAgent, directory: dir })
  const waiting = new Map<number, { resolve(v: any): void }>()
  const notifications: any[] = []
  const requests: any[] = []
  let handler: (request: any) => unknown = () => ({})
  let nextID = 1
  let buffer = ""
  fromAgent.setEncoding("utf8")
  fromAgent.on("data", (chunk: string) => {
    buffer += chunk
    let at: number
    while ((at = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      const m = JSON.parse(line)
      if (m.method === undefined) waiting.get(m.id)?.resolve(m)
      else if (m.id === undefined) notifications.push(m)
      else {
        requests.push(m)
        void Promise.resolve(handler(m)).then((result) => toAgent.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\n"))
      }
    }
  })
  return {
    notifications,
    requests,
    onRequest: (fn: (request: any) => unknown) => (handler = fn),
    call: (method: string, params?: unknown) =>
      new Promise<any>((resolve) => {
        const id = nextID++
        waiting.set(id, { resolve })
        toAgent.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
      }),
    notify: (method: string, params?: unknown) => toAgent.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"),
    raw: (line: string) => toAgent.write(line + "\n"),
    updates: (kind?: string) => notifications.filter((n) => n.method === "session/update" && (!kind || n.params.update.sessionUpdate === kind)).map((n) => n.params.update),
    close: async () => {
      toAgent.end()
      await done
    },
  }
}

async function open(client: ReturnType<typeof connect>) {
  const init = await client.call("initialize", { protocolVersion: 1, clientCapabilities: {} })
  expect(init.error).toBeUndefined()
  const created = await client.call("session/new", { cwd: dir, mcpServers: [] })
  return { init: init.result, sessionId: created.result.sessionId as string, created: created.result }
}

test("handshake, capabilities and modes", async () => {
  const client = connect()
  const { init, created, sessionId } = await open(client)
  expect(init.protocolVersion).toBe(1)
  expect(init.agentCapabilities.promptCapabilities).toMatchObject({ image: true, embeddedContext: true })
  expect(init.authMethods).toEqual([])
  expect(init.agentInfo.name).toBe("deberopa")
  expect(sessionId).toMatch(/^ses_/)
  expect(created.modes.availableModes.map((m: any) => m.id)).toEqual(expect.arrayContaining(["build", "plan"]))
  await client.close()
})

test("a prompt streams message chunks and ends the turn", async () => {
  const client = connect()
  const { sessionId } = await open(client)
  mock.queue(reply.text("Hello from the agent."))
  const result = await client.call("session/prompt", { sessionId, prompt: [{ type: "text", text: "say hello" }] })
  expect(result.result).toEqual({ stopReason: "end_turn" })
  const chunks = client.updates("agent_message_chunk").map((u) => u.content.text)
  expect(chunks.join("")).toBe("Hello from the agent.")
  expect(chunks.length).toBeGreaterThan(1) // streamed, not one blob
  await client.close()
})

test("tool calls are reported, and edits wait for the editor's permission", async () => {
  const client = connect()
  const { sessionId } = await open(client)
  client.onRequest((request) => {
    expect(request.method).toBe("session/request_permission")
    expect(request.params.sessionId).toBe(sessionId)
    expect(request.params.options.map((o: any) => o.kind)).toEqual(["allow_once", "allow_always", "reject_once"])
    return { outcome: { outcome: "selected", optionId: "allow_once" } }
  })
  mock.queue(reply.tools([{ name: "write", args: { filePath: "out.txt", content: "from acp\n" }, id: "call_w1" }]), reply.text("Written."))
  const result = await client.call("session/prompt", { sessionId, prompt: [{ type: "text", text: "create out.txt" }] })
  expect(result.result.stopReason).toBe("end_turn")
  expect(fs.readFileSync(path.join(dir, "out.txt"), "utf8")).toBe("from acp\n")

  expect(client.requests).toHaveLength(1)
  const calls = client.updates("tool_call")
  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({ toolCallId: "call_w1", kind: "edit" })
  const completed = client.updates("tool_call_update").find((u) => u.status === "completed")!
  expect(completed.toolCallId).toBe("call_w1")
  expect(completed.content[0].content.text).toContain("from acp") // the diff
  expect(completed.locations[0].path).toBe(path.join(dir, "out.txt"))
  await client.close()
})

test("rejecting a permission stops the edit", async () => {
  const client = connect()
  const { sessionId } = await open(client)
  client.onRequest(() => ({ outcome: { outcome: "selected", optionId: "reject_once" } }))
  mock.queue(reply.tools([{ name: "write", args: { filePath: "no.txt", content: "x" } }]), reply.text("ok"))
  await client.call("session/prompt", { sessionId, prompt: [{ type: "text", text: "create no.txt" }] })
  expect(fs.existsSync(path.join(dir, "no.txt"))).toBe(false)
  expect(client.updates("tool_call_update").some((u) => u.status === "failed")).toBe(true)
  await client.close()
})

test("session/cancel ends a running prompt as cancelled", async () => {
  const client = connect()
  const { sessionId } = await open(client)
  mock.queue({ ...reply.text("a long answer that will not finish"), delayMs: 4000 })
  const pending = client.call("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] })
  await new Promise((r) => setTimeout(r, 300))
  client.notify("session/cancel", { sessionId })
  const result = await Promise.race([pending, new Promise((_, rej) => setTimeout(() => rej(new Error("cancel did not end the prompt")), 4000))])
  expect((result as any).result).toEqual({ stopReason: "cancelled" })
  await client.close()
})

test("switching mode, loading a session, and error cases", async () => {
  const client = connect()
  const { sessionId } = await open(client)
  expect((await client.call("session/set_mode", { sessionId, modeId: "plan" })).result).toEqual({})
  expect(client.updates("current_mode_update")[0]).toMatchObject({ currentModeId: "plan" })
  expect((await client.call("session/set_mode", { sessionId, modeId: "nope" })).error.code).toBe(-32602)

  mock.queue(reply.text("remember me"))
  await client.call("session/prompt", { sessionId, prompt: [{ type: "text", text: "first" }] })
  const before = client.notifications.length
  expect((await client.call("session/load", { sessionId, mcpServers: [] })).error).toBeUndefined()
  const replayed = client.notifications.slice(before).map((n) => n.params.update)
  expect(replayed.map((u) => u.sessionUpdate)).toEqual(expect.arrayContaining(["user_message_chunk", "agent_message_chunk"]))

  expect((await client.call("session/prompt", { sessionId: "ses_missing", prompt: [{ type: "text", text: "x" }] })).error.code).toBe(-32602)
  expect((await client.call("session/prompt", { sessionId, prompt: [] })).error.message).toContain("empty")
  expect((await client.call("nonsense/method")).error.code).toBe(-32601)
  expect((await client.call("session/new", { cwd: path.join(dir, "..", "elsewhere-abs") })).error.message).toContain("Start another")
  client.raw("{not json")
  await new Promise((r) => setTimeout(r, 50))
  await client.close()
})

test("session/new before initialize is refused", async () => {
  const client = connect()
  const result = await client.call("session/new", { cwd: dir })
  expect(result.error.code).toBe(-32002)
  await client.close()
})

test("prompt content blocks become text and attachments", () => {
  // real editors send absolute file URLs for the platform they run on
  const a = path.resolve(dir, "src", "a.ts")
  const b = path.resolve(dir, "b.txt")
  const out = fromContentBlocks([
    { type: "text", text: "look at this" },
    { type: "resource_link", uri: pathToFileURL(a).href, name: "a.ts" },
    { type: "resource", resource: { uri: pathToFileURL(b).href, text: "bee" } },
    { type: "image", data: "AAAA", mimeType: "image/png" },
    { type: "audio", data: "x", mimeType: "audio/wav" },
  ])
  expect(out.text).toContain("look at this")
  expect(out.text).toContain(`@${a}`)
  expect(out.text).toContain(`Contents of ${b}:`)
  expect(out.text).toContain("bee")
  expect(out.files).toEqual([{ mime: "image/png", data: "AAAA" }])
})
