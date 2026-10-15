import { afterAll, beforeAll, expect, test } from "bun:test"
import { startServer } from "../src/server/server"
import { closeAllTerminals } from "../src/pty/pty"
import { subscribe } from "../src/util/bus"
import { endProject, mockConfig, startMockLLM, tmpDir, useProject, type MockLLM } from "./helpers"

let mock: MockLLM
let server: ReturnType<typeof startServer>

const call = async (method: string, route: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:${server.port}${route}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } })
  const text = await res.text()
  let data: any = text
  try {
    data = JSON.parse(text)
  } catch {}
  return { status: res.status, data }
}

beforeAll(() => {
  mock = startMockLLM()
  useProject(tmpDir(), mockConfig(mock))
  server = startServer({ port: 0 })
})
afterAll(() => {
  closeAllTerminals()
  server.stop(true)
  mock.stop()
  endProject()
})

const waitFor = async (what: string, test: () => boolean, ms = 15000) => {
  const end = Date.now() + ms
  while (!test()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(50)
  }
}

test("a terminal runs the user's shell, streams its output and ends", async () => {
  let output = ""
  let exit: { id: string; code: number | null } | undefined
  const off1 = subscribe<{ id: string; data: string }>("pty.data", (e) => {
    output += e.properties.data
  })
  const off2 = subscribe<{ id: string; code: number | null }>("pty.exit", (e) => {
    exit = e.properties
  })
  try {
    const opened = await call("POST", "/pty", { cols: 100, rows: 30 })
    expect(opened.status).toBe(201)
    expect(opened.data.id).toMatch(/^term_/)
    expect(typeof opened.data.pty).toBe("boolean")
    expect((await call("GET", "/pty")).data.map((t: any) => t.id)).toContain(opened.data.id)

    // enter is "\r" in a terminal; "\r\n" also works on plain pipes
    expect((await call("POST", `/pty/${opened.data.id}/input`, { data: "echo deberopa-pty-marker\r\n" })).status).toBe(200)
    await waitFor("the shell's output", () => output.includes("deberopa-pty-marker"))
    expect((await call("POST", `/pty/${opened.data.id}/resize`, { cols: 120, rows: 40 })).status).toBe(200)

    expect((await call("DELETE", `/pty/${opened.data.id}`)).status).toBe(200)
    expect((await call("POST", `/pty/${opened.data.id}/input`, { data: "x" })).status).toBe(404)
    expect((await call("GET", "/pty")).data.length).toBe(0)
    void exit
  } finally {
    off1()
    off2()
  }
})

test("a terminal's folder must be inside the project and bad requests are refused", async () => {
  expect((await call("POST", "/pty", { cwd: "../.." })).status).toBe(400)
  expect((await call("POST", "/pty/none/input", { data: "x" })).status).toBe(404)
  const opened = await call("POST", "/pty", {})
  expect((await call("POST", `/pty/${opened.data.id}/input`, {})).status).toBe(400)
  expect((await call("POST", `/pty/${opened.data.id}/resize`, { cols: "a" })).status).toBe(400)
  await call("DELETE", `/pty/${opened.data.id}`)
})
