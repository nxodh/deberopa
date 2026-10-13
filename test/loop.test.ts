import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { prompt, cancel, isBusy } from "../src/session/prompt"
import { createSession, getMessages } from "../src/session/store"
import { messageText, type ToolPart } from "../src/session/message"
import { subscribe } from "../src/util/bus"
import { pendingPermissions, replyPermission } from "../src/permission/permission"
import { mockConfig, reply, startMockLLM, tmpDir, useProject, type MockLLM } from "./helpers"

let mock: MockLLM
let dir: string

beforeAll(() => {
  mock = startMockLLM()
})
afterAll(() => mock.stop())

beforeEach(() => {
  dir = tmpDir()
  mock.reset()
  useProject(dir, mockConfig(mock))
})

function toolParts(messages: Awaited<ReturnType<typeof getMessages>>) {
  return messages.flatMap((m) => m.parts).filter((p): p is ToolPart => p.type === "tool")
}

test("plain text reply is streamed and stored", async () => {
  const session = await createSession()
  const deltas: string[] = []
  const off = subscribe("message.part.updated", (e) => {
    if (e.properties.delta) deltas.push(e.properties.delta)
  })
  mock.queue(reply.text("Hello from the mock"))
  const result = await prompt({ sessionID: session.id, text: "hi" })
  off()
  expect(result && messageText(result)).toBe("Hello from the mock")
  expect(deltas.join("")).toBe("Hello from the mock")
  expect(result?.tokens.output).toBe(5)
  const messages = await getMessages(session.id)
  expect(messages.map((m) => m.role)).toEqual(["user", "assistant"])
  expect(mock.requests[0].messages[0].role).toBe("system")
  expect(mock.requests[0].messages.at(-1)).toEqual({ role: "user", content: "hi" })
})

test("tool call round trip reads a file and continues", async () => {
  fs.writeFileSync(path.join(dir, "notes.txt"), "line one\nline two\n")
  const session = await createSession()
  mock.queue(reply.tools([{ name: "read", args: { filePath: path.join(dir, "notes.txt") } }]), reply.text("The file has two lines."))
  const result = await prompt({ sessionID: session.id, text: "read notes.txt" })
  expect(result && messageText(result)).toBe("The file has two lines.")
  const parts = toolParts(await getMessages(session.id))
  expect(parts).toHaveLength(1)
  expect(parts[0]!.state.status).toBe("completed")
  // the second request carried the tool result back
  const second = mock.requests.find((r) => r.messages.some((m: any) => m.role === "tool"))
  expect(second.messages.find((m: any) => m.role === "tool").content).toContain("line two")
})

test("write tool asks for permission, and approval lets it through", async () => {
  const session = await createSession()
  useProject(dir, mockConfig(mock, { permission: { edit: "ask" } }))
  const target = path.join(dir, "out.txt")
  mock.queue(reply.tools([{ name: "write", args: { filePath: target, content: "hello" } }]), reply.text("done"))
  const off = subscribe("permission.asked", (e) => {
    setTimeout(() => replyPermission(e.properties.id, "once"), 5)
  })
  await prompt({ sessionID: session.id, text: "write it" })
  off()
  expect(fs.readFileSync(target, "utf8")).toBe("hello")
  expect(pendingPermissions()).toHaveLength(0)
})

test("rejected permission stops the turn and leaves the file alone", async () => {
  const session = await createSession()
  useProject(dir, mockConfig(mock, { permission: { edit: "ask" } }))
  const target = path.join(dir, "no.txt")
  mock.queue(reply.tools([{ name: "write", args: { filePath: target, content: "x" } }]), reply.text("should not be reached"))
  const off = subscribe("permission.asked", (e) => {
    setTimeout(() => replyPermission(e.properties.id, "reject"), 5)
  })
  await prompt({ sessionID: session.id, text: "write it" })
  off()
  expect(fs.existsSync(target)).toBe(false)
  const parts = toolParts(await getMessages(session.id))
  expect(parts[0]!.state.status).toBe("error")
  expect(mock.requests.length).toBeLessThanOrEqual(2) // no further model round after the rejection
})

test("deny rule makes the tool unavailable to the model", async () => {
  const session = await createSession()
  useProject(dir, mockConfig(mock, { permission: { bash: "deny" } }))
  mock.queue(reply.text("ok"))
  await prompt({ sessionID: session.id, text: "hi" })
  const names = (mock.requests[0].tools as any[]).map((t) => t.function.name)
  expect(names).not.toContain("bash")
  expect(names).toContain("read")
})

test("retryable provider errors are retried", async () => {
  const session = await createSession()
  mock.queue(reply.error(503, "overloaded"), reply.text("recovered"))
  const statuses: string[] = []
  const off = subscribe("session.status", (e) => statuses.push(e.properties.status.type))
  const result = await prompt({ sessionID: session.id, text: "hi" })
  off()
  expect(result && messageText(result)).toBe("recovered")
  expect(statuses).toContain("retry")
}, 15000)

test("non-retryable errors are recorded on the message", async () => {
  const session = await createSession()
  mock.queue(reply.error(401, "bad key"))
  const result = await prompt({ sessionID: session.id, text: "hi" })
  expect(result?.error?.message).toContain("bad key")
})

test("cancel interrupts a streaming turn", async () => {
  const session = await createSession()
  mock.queue({ ...reply.text("slow"), delayMs: 5000 })
  const run = prompt({ sessionID: session.id, text: "hi" })
  await Bun.sleep(150)
  expect(isBusy(session.id)).toBe(true)
  expect(cancel(session.id)).toBe(true)
  const result = await run
  expect(result?.error?.name).toBe("Aborted")
  expect(isBusy(session.id)).toBe(false)
})

test("a second prompt on a busy session is rejected", async () => {
  const session = await createSession()
  mock.queue({ ...reply.text("slow"), delayMs: 300 })
  const first = prompt({ sessionID: session.id, text: "one" })
  await Bun.sleep(50)
  await expect(prompt({ sessionID: session.id, text: "two" })).rejects.toThrow(/busy/)
  await first
})

test("parallel tool calls all run and are answered", async () => {
  fs.writeFileSync(path.join(dir, "a.txt"), "AAA")
  fs.writeFileSync(path.join(dir, "b.txt"), "BBB")
  const session = await createSession()
  mock.queue(
    reply.tools([
      { name: "read", args: { filePath: path.join(dir, "a.txt") }, id: "c1" },
      { name: "read", args: { filePath: path.join(dir, "b.txt") }, id: "c2" },
    ]),
    reply.text("both read"),
  )
  await prompt({ sessionID: session.id, text: "read both" })
  const tools = mock.requests.find((r) => r.messages.some((m: any) => m.role === "tool")).messages.filter((m: any) => m.role === "tool")
  expect(tools.map((t: any) => t.tool_call_id)).toEqual(["c1", "c2"])
})

test("invalid tool arguments are reported back to the model", async () => {
  const session = await createSession()
  mock.queue(reply.tools([{ name: "read", args: {} }]), reply.text("fixed"))
  await prompt({ sessionID: session.id, text: "x" })
  const part = toolParts(await getMessages(session.id))[0]!
  expect(part.state.status).toBe("error")
  expect((part.state as any).error).toContain("filePath")
})
