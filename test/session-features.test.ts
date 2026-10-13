import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { prompt } from "../src/session/prompt"
import { createSession, deleteSession, getMessages, getSession } from "../src/session/store"
import { redo, revert, undo, unrevert, visibleMessages } from "../src/session/revert"
import { exportJSON, exportMarkdown, forkSession, importExport, parseExport } from "../src/session/export"
import { mockConfig, reply, startMockLLM, tmpDir, useProject, type MockLLM, endProject } from "./helpers"

let mock: MockLLM
let dir: string

beforeAll(() => {
  mock = startMockLLM()
})
afterAll(() => mock.stop())

beforeEach(() => {
  dir = tmpDir()
  spawnSync("git", ["init", "-q"], { cwd: dir })
  mock.reset()
  useProject(dir, mockConfig(mock, { snapshot: true }))
})

async function turn(sessionID: string, file: string, content: string, text = "write it") {
  mock.queue(reply.tools([{ name: "write", args: { filePath: path.join(dir, file), content } }]), reply.text(`wrote ${file}`))
  await prompt({ sessionID, text })
}

test("undo restores files and hides messages; redo brings both back", async () => {
  const s = await createSession()
  await turn(s.id, "a.txt", "one", "first")
  await turn(s.id, "b.txt", "two", "second")
  expect(fs.existsSync(path.join(dir, "b.txt"))).toBe(true)

  const result = await undo(s.id)
  expect(result.message.parts[0]).toMatchObject({ text: "second" })
  expect(fs.existsSync(path.join(dir, "b.txt"))).toBe(false)
  expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("one")
  const hidden = await visibleMessages(s.id)
  expect(hidden.length).toBeLessThan((await getMessages(s.id)).length)

  await undo(s.id)
  expect(fs.existsSync(path.join(dir, "a.txt"))).toBe(false)

  const first = await redo(s.id)
  expect(first.done).toBe(false)
  expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("one")
  expect(fs.existsSync(path.join(dir, "b.txt"))).toBe(false)

  const second = await redo(s.id)
  expect(second.done).toBe(true)
  expect(fs.readFileSync(path.join(dir, "b.txt"), "utf8")).toBe("two")
  expect((await getSession(s.id))?.revert).toBeUndefined()
})

test("undo also reverts modifications to an existing file, and a new prompt drops hidden messages", async () => {
  fs.writeFileSync(path.join(dir, "a.txt"), "original")
  const s = await createSession()
  const file = path.join(dir, "a.txt")
  mock.queue(
    reply.tools([{ name: "read", args: { filePath: file } }]),
    reply.tools([{ name: "write", args: { filePath: file, content: "changed" } }]),
    reply.text("done"),
  )
  await prompt({ sessionID: s.id, text: "write it" })
  expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("changed")
  await undo(s.id)
  expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("original")
  const before = (await getMessages(s.id)).length
  mock.queue(reply.text("fresh start"))
  await prompt({ sessionID: s.id, text: "something else" })
  const after = await getMessages(s.id)
  expect(after.length).toBeLessThan(before + 2)
  expect(after.some((m) => m.parts.some((p) => p.type === "text" && p.text === "write it"))).toBe(false)
  expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("original")
})

test("unrevert restores the latest state in one go", async () => {
  const s = await createSession()
  await turn(s.id, "a.txt", "one", "first")
  await turn(s.id, "b.txt", "two", "second")
  const first = (await getMessages(s.id)).find((m) => m.role === "user")!
  await revert(s.id, first.id)
  expect(fs.existsSync(path.join(dir, "a.txt"))).toBe(false)
  expect(fs.existsSync(path.join(dir, "b.txt"))).toBe(false)
  await unrevert(s.id)
  expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("one")
  expect(fs.readFileSync(path.join(dir, "b.txt"), "utf8")).toBe("two")
})

test("export to JSON and markdown, import as a new session, fork", async () => {
  const s = await createSession()
  mock.queue(reply.text("A **bold** answer"))
  await prompt({ sessionID: s.id, text: "question?" })

  const md = await exportMarkdown(s.id)
  expect(md).toContain("## User")
  expect(md).toContain("question?")
  expect(md).toContain("A **bold** answer")

  const exported = await exportJSON(s.id)
  const parsed = parseExport(JSON.stringify(exported))
  const imported = await importExport(parsed)
  expect(imported.id).not.toBe(s.id)
  const copied = await getMessages(imported.id)
  expect(copied).toHaveLength(2)
  expect(copied.every((m) => m.sessionID === imported.id)).toBe(true)
  if (copied[1]!.role === "assistant") expect(copied[1]!.parentID).toBe(copied[0]!.id)

  const fork = await forkSession(s.id)
  expect((await getMessages(fork.id)).length).toBe(2)
  expect(fork.title).toContain("(fork)")
  await deleteSession(fork.id)
  expect(await getSession(fork.id)).toBeUndefined()

  expect(() => parseExport("{}")).toThrow(/not a Vedecaps/)
  expect(() => parseExport("nope")).toThrow(/valid JSON/)
})

afterAll(endProject)

test("an @file#L2-3 mention attaches only those lines", async () => {
  const file = path.join(dir, "ranged.txt")
  fs.writeFileSync(file, ["one", "two", "three", "four"].join("\n") + "\n")
  const session = await createSession()
  mock.queue(reply.text("ok"))
  await prompt({ sessionID: session.id, text: "look at @ranged.txt#L2-3" })
  const user = (await getMessages(session.id)).find((m) => m.role === "user")!
  const attached = user.parts.filter((p) => p.type === "text" && p.synthetic).map((p) => (p.type === "text" ? p.text : "")).join("\n")
  expect(attached).toContain('"offset":2')
  expect(attached).toContain('"limit":2')
  expect(attached).toContain("two")
  expect(attached).toContain("three")
  expect(attached).not.toContain("one\n")
  expect(attached).not.toContain("four")
})
