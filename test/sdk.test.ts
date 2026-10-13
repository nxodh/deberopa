import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { startServer as startApi } from "../src/server/server"
import { createClient, messageText, VedecapsError } from "../sdk/js/src/index"
import { endProject, mockConfig, reply, startMockLLM, tmpDir, useProject, type MockLLM } from "./helpers"

let mock: MockLLM
let api: ReturnType<typeof startApi>
let client: ReturnType<typeof createClient>
let dir: string

beforeAll(() => {
  mock = startMockLLM()
  dir = tmpDir()
  fs.writeFileSync(path.join(dir, "hello.txt"), "hello from disk\n")
  useProject(dir, mockConfig(mock, { permission: { edit: "ask" } }))
  api = startApi({ port: 0 })
  client = createClient({ baseUrl: `http://127.0.0.1:${api.port}` })
})
afterAll(() => {
  api.stop(true)
  mock.stop()
  endProject()
})

test("sessions: create, prompt, read back, rename, delete", async () => {
  expect((await client.health()).ok).toBe(true)
  const session = await client.session.create({ title: "sdk" })
  mock.queue(reply.text("hello sdk"))
  const answer = await client.session.prompt(session.id, { text: "hi", model: "mock/mock-1" })
  expect(messageText(answer)).toBe("hello sdk")
  const messages = await client.session.messages(session.id)
  expect(messages.map((m) => m.role)).toEqual(["user", "assistant"])
  expect((await client.session.update(session.id, { title: "renamed" })).title).toBe("renamed")
  expect(await client.session.export(session.id)).toContain("hello sdk")
  await client.session.delete(session.id)
  const missing = await client.session.get(session.id).catch((e) => e)
  expect(missing).toBeInstanceOf(VedecapsError)
  expect(missing.status).toBe(404)
})

test("events and permissions: an agent edit waits for the SDK's answer", async () => {
  const session = await client.session.create()
  mock.queue(reply.tools([{ name: "write", args: { filePath: "made.txt", content: "created via sdk\n" } }]), reply.text("done"))

  const controller = new AbortController()
  const types: string[] = []
  const answered = (async () => {
    for await (const event of client.event.subscribe(controller.signal)) {
      types.push(event.type)
      if (event.type === "permission.asked") {
        expect(event.properties.permission).toBe("edit")
        await client.permission.reply(event.properties.id, "once")
      }
      if (event.type === "session.idle" && event.properties.sessionID === session.id) break
    }
  })()

  expect((await client.session.promptAsync(session.id, { text: "make the file" })).accepted).toBe(true)
  await Promise.race([answered, new Promise((_, reject) => setTimeout(() => reject(new Error("no idle event")), 8000))])
  controller.abort()

  expect(types).toContain("permission.asked")
  expect(types).toContain("message.part.updated")
  expect(fs.readFileSync(path.join(dir, "made.txt"), "utf8")).toBe("created via sdk\n")
  const text = messageText((await client.session.messages(session.id)).at(-1))
  expect(text).toBe("done")
})

test("lookups and errors", async () => {
  expect((await client.agent.list()).map((a) => a.name)).toContain("build")
  expect((await client.find.files("hello"))[0]).toBe("hello.txt")
  expect((await client.provider.list()).providers.some((p) => p.id === "mock")).toBe(true)
  const bad = await client.session.prompt("ses_missing", { text: "x" }).catch((e) => e)
  expect(bad).toBeInstanceOf(VedecapsError)
  expect(bad.message).toContain("not found")
})

test("password-protected servers", async () => {
  const locked = startApi({ port: 0, password: "pw" })
  try {
    const url = `http://127.0.0.1:${locked.port}`
    expect(await createClient({ baseUrl: url }).health().catch((e) => e.status)).toBe(401)
    expect((await createClient({ baseUrl: url, password: "pw" }).health()).ok).toBe(true)
  } finally {
    locked.stop(true)
  }
})
