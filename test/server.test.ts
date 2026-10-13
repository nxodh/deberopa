import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { startServer } from "../src/server/server"
import { endProject, mockConfig, reply, startMockLLM, tmpDir, useProject, type MockLLM } from "./helpers"

let mock: MockLLM
let server: ReturnType<typeof startServer>
let base: string

beforeAll(() => {
  mock = startMockLLM()
  const dir = tmpDir()
  fs.writeFileSync(path.join(dir, "alpha.txt"), "a")
  fs.mkdirSync(path.join(dir, "src"))
  fs.writeFileSync(path.join(dir, "src", "beta.ts"), "b")
  useProject(dir, mockConfig(mock, { provider: { mock: { name: "Mock", api: mock.url, options: { apiKey: "sk-test-not-a-real-key-000000000000" }, models: { "mock-1": { name: "Mock 1", tool_call: true } } } } }))
  server = startServer({ port: 0 })
  base = `http://127.0.0.1:${server.port}`
})
afterAll(() => {
  server.stop(true)
  mock.stop()
  endProject()
})

const call = async (method: string, route: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(base + route, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json", ...headers } })
  const text = await res.text()
  let data: any = text
  try {
    data = JSON.parse(text)
  } catch {}
  return { status: res.status, data }
}

test("health, agents, providers and config never expose keys", async () => {
  expect((await call("GET", "/health")).data.ok).toBe(true)
  const agents = (await call("GET", "/agent")).data
  expect(agents.map((a: any) => a.name)).toContain("build")
  const providers = await call("GET", "/provider")
  expect(JSON.stringify(providers.data)).not.toContain("sk-test-not-a-real-key")
  expect(providers.data.providers.find((p: any) => p.id === "mock").connected).toBe(true)
  expect(providers.data.default).toEqual({ providerID: "mock", modelID: "mock-1" })
  expect(JSON.stringify((await call("GET", "/config")).data)).not.toContain("sk-test-not-a-real-key")
})

test("session lifecycle and a prompt round trip", async () => {
  const created = await call("POST", "/session", { title: "from the api" })
  expect(created.status).toBe(201)
  const id = created.data.id
  expect((await call("GET", "/session")).data.some((s: any) => s.id === id)).toBe(true)

  mock.queue(reply.text("server says hi"))
  const answer = await call("POST", `/session/${id}/message`, { text: "hello" })
  expect(answer.status).toBe(200)
  expect(answer.data.role).toBe("assistant")
  expect(answer.data.raw).toBeUndefined()
  expect(answer.data.parts.find((p: any) => p.type === "text").text).toBe("server says hi")

  const messages = (await call("GET", `/session/${id}/message`)).data
  expect(messages.map((m: any) => m.role)).toEqual(["user", "assistant"])
  expect((await call("GET", `/session/${id}/export`)).data).toContain("server says hi")

  expect((await call("PATCH", `/session/${id}`, { title: "renamed" })).data.title).toBe("renamed")
  expect((await call("POST", `/session/${id}/message`, {})).status).toBe(400)
  expect((await call("DELETE", `/session/${id}`)).data).toBe(true)
  expect((await call("GET", `/session/${id}`)).status).toBe(404)
})

test("async prompts report through the event stream", async () => {
  const id = (await call("POST", "/session", {})).data.id
  const controller = new AbortController()
  const res = await fetch(base + "/event", { signal: controller.signal })
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let seen = ""
  const until = async (needle: string) => {
    const deadline = Date.now() + 5000
    while (!seen.includes(needle) && Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      seen += decoder.decode(value)
    }
    return seen.includes(needle)
  }
  expect(await until("server.connected")).toBe(true)
  mock.queue(reply.text("streamed"))
  expect((await call("POST", `/session/${id}/prompt_async`, { text: "go" })).status).toBe(202)
  expect(await until('"session.idle"')).toBe(true)
  expect(seen).toContain("message.part.updated")
  controller.abort()
})

test("file search, unknown routes and bad input", async () => {
  expect((await call("GET", "/find/file?query=beta")).data).toEqual(["src/beta.ts"])
  expect((await call("GET", "/nope")).status).toBe(404)
  expect((await call("POST", "/permission/per_missing", { reply: "once" })).status).toBe(404)
  expect((await call("POST", "/permission/per_missing", { reply: "maybe" })).status).toBe(400)
  expect((await call("GET", "/session/ses_missing/message")).status).toBe(404)
})

test("password protects every route", async () => {
  const locked = startServer({ port: 0, password: "open-sesame" })
  try {
    const url = `http://127.0.0.1:${locked.port}/health`
    expect((await fetch(url)).status).toBe(401)
    expect((await fetch(url, { headers: { authorization: "Basic " + btoa("vedecaps:wrong") } })).status).toBe(401)
    expect((await fetch(url, { headers: { authorization: "Basic " + btoa("vedecaps:open-sesame") } })).status).toBe(200)
  } finally {
    locked.stop(true)
  }
})
