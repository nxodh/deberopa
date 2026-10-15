import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { startServer } from "../src/server/server"
import { track } from "../src/snapshot/snapshot"
import { endProject, mockConfig, startMockLLM, tmpDir, useProject, type MockLLM } from "./helpers"

let mock: MockLLM
let server: ReturnType<typeof startServer>
let dir: string

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
})
afterAll(() => {
  server?.stop(true)
  mock.stop()
  endProject()
})
beforeEach(() => {
  server?.stop(true)
  dir = tmpDir()
  spawnSync("git", ["init", "-q"], { cwd: dir })
  useProject(dir, mockConfig(mock, { snapshot: true }))
  server = startServer({ port: 0 })
})

test("diff and revert show and undo what changed since a snapshot", async () => {
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n")
  fs.writeFileSync(path.join(dir, "b.txt"), "keep\n")
  const hash = (await track())!
  expect(hash).toMatch(/^[0-9a-f]{40,64}$/)
  fs.writeFileSync(path.join(dir, "a.txt"), "two\n")
  fs.writeFileSync(path.join(dir, "c.txt"), "new\n")

  const all = await call("GET", `/snapshot/diff?hash=${hash}`)
  expect(all.status).toBe(200)
  expect(all.data.diff).toContain("-one")
  expect(all.data.diff).toContain("+two")
  expect(all.data.diff).toContain("c.txt")

  const one = await call("GET", `/snapshot/diff?hash=${hash}&file=a.txt`)
  expect(one.data.diff).toContain("+two")
  expect(one.data.diff).not.toContain("c.txt")

  const reverted = await call("POST", "/snapshot/revert", { hash, files: ["a.txt", "c.txt"] })
  expect(reverted.status).toBe(200)
  expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("one\n")
  // a file that did not exist then is removed
  expect(fs.existsSync(path.join(dir, "c.txt"))).toBe(false)
  expect(fs.readFileSync(path.join(dir, "b.txt"), "utf8")).toBe("keep\n")
  expect(reverted.data.changed).toEqual([])
})

test("diff and revert refuse bad snapshot ids and paths outside the project", async () => {
  expect((await call("GET", "/snapshot/diff?hash=not-a-hash")).status).toBe(400)
  expect((await call("GET", `/snapshot/diff?hash=${"a".repeat(40)}&file=../../etc/passwd`)).status).toBe(400)
  expect((await call("POST", "/snapshot/revert", { hash: "a".repeat(40), files: ["../outside.txt"] })).status).toBe(400)
  expect((await call("POST", "/snapshot/revert", { hash: "zz", files: ["a.txt"] })).status).toBe(400)
  expect((await call("POST", "/snapshot/revert", { hash: "a".repeat(40), files: [] })).status).toBe(400)
  expect((await call("GET", "/snapshot/status")).data.available).toBe(true)
})
