import { afterAll, beforeEach, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { loadConfig, resetConfig } from "../src/config/config"
import { legacyEnvWarning, migrateEnv, migrateLegacyDirs } from "../src/legacy"
import { initProject } from "../src/project"
import { detectLocalServers, setDefaultEndpoints } from "../src/provider/local"
import { tmpDir } from "./helpers"

// This file is allowed to spell the pre-rename names: it tests that they are still read (once).
const OLD = "vedecaps"
const OLD_ENV = "VEDECAPS_"

afterAll(() => {
  delete process.env.DEBEROPA_CONFIG_CONTENT
  setDefaultEndpoints(undefined)
})

test("old environment variable names are mapped to the new ones and reported", () => {
  const env: NodeJS.ProcessEnv = { [`${OLD_ENV}CONFIG_CONTENT`]: "{}", [`${OLD_ENV}HOME`]: "/old", DEBEROPA_HOME: "/new", UNRELATED: "x" }
  const used = migrateEnv(env)
  // the new name wins when both are set
  expect(env.DEBEROPA_HOME).toBe("/new")
  expect(env.DEBEROPA_CONFIG_CONTENT).toBe("{}")
  expect(used).toEqual([`${OLD_ENV}CONFIG_CONTENT`])
  expect(legacyEnvWarning(used)).toContain("DEBEROPA_CONFIG_CONTENT")
  expect(legacyEnvWarning([])).toBeUndefined()
})

function legacyTree() {
  const root = tmpDir("vdc-legacy-")
  const old = { config: path.join(root, "old", "config"), data: path.join(root, "old", "data"), state: path.join(root, "old", "state") }
  const now = { config: path.join(root, "new", "config"), data: path.join(root, "new", "data"), state: path.join(root, "new", "state") }
  fs.mkdirSync(path.join(old.config, "agent"), { recursive: true })
  fs.writeFileSync(path.join(old.config, `${OLD}.json`), JSON.stringify({ model: "a/b" }))
  fs.writeFileSync(path.join(old.config, "agent", "reviewer.md"), "---\ndescription: r\n---\nReview.")
  fs.mkdirSync(path.join(old.data, "storage", "session"), { recursive: true })
  fs.writeFileSync(path.join(old.data, "auth.json"), JSON.stringify({ test: { type: "api", key: "sk-test-not-a-real-key" } }), { mode: 0o600 })
  fs.writeFileSync(path.join(old.data, "storage", "session", "s1.json"), "{}")
  fs.mkdirSync(path.join(old.data, "log"), { recursive: true })
  fs.writeFileSync(path.join(old.data, "log", "big.log"), "x")
  fs.mkdirSync(old.state, { recursive: true })
  fs.writeFileSync(path.join(old.state, "trusted-projects.json"), "[]")
  return { root, old, now }
}

test("D4: the first run copies settings, logins, sessions and state, and leaves the old folders alone", () => {
  const { old, now } = legacyTree()
  const copied = migrateLegacyDirs(old, now)
  expect(copied).toEqual(["settings", "logins and sessions", "state"])
  // the settings file gets its new name; other settings files come along
  expect(fs.existsSync(path.join(now.config, `${OLD}.json`))).toBe(false)
  expect(JSON.parse(fs.readFileSync(path.join(now.config, "deberopa.json"), "utf8"))).toEqual({ model: "a/b" })
  expect(fs.existsSync(path.join(now.config, "agent", "reviewer.md"))).toBe(true)
  expect(fs.existsSync(path.join(now.data, "auth.json"))).toBe(true)
  if (process.platform !== "win32") expect(fs.statSync(path.join(now.data, "auth.json")).mode & 0o777).toBe(0o600)
  expect(fs.existsSync(path.join(now.data, "storage", "session", "s1.json"))).toBe(true)
  // logs and caches are not worth copying
  expect(fs.existsSync(path.join(now.data, "log"))).toBe(false)
  expect(fs.existsSync(path.join(now.state, "trusted-projects.json"))).toBe(true)
  // nothing was written to, or removed from, the old folders
  expect(fs.existsSync(path.join(old.config, `${OLD}.json`))).toBe(true)
  expect(fs.existsSync(path.join(old.data, "auth.json"))).toBe(true)
})

test("D4: an existing new folder is never touched, and a second run copies nothing", () => {
  const { old, now } = legacyTree()
  fs.mkdirSync(now.config, { recursive: true })
  fs.writeFileSync(path.join(now.config, "deberopa.json"), JSON.stringify({ model: "new/one" }))
  expect(migrateLegacyDirs(old, now)).toEqual(["logins and sessions", "state"])
  expect(JSON.parse(fs.readFileSync(path.join(now.config, "deberopa.json"), "utf8"))).toEqual({ model: "new/one" })
  expect(migrateLegacyDirs(old, now)).toEqual([])
})

test("D4: nothing to migrate is fine", () => {
  const root = tmpDir("vdc-legacy-none-")
  const dirs = (n: string) => ({ config: path.join(root, n, "c"), data: path.join(root, n, "d"), state: path.join(root, n, "s") })
  expect(migrateLegacyDirs(dirs("old"), dirs("new"))).toEqual([])
})

// ---- project files written before the rename -----------------------------------------------

let dir: string
beforeEach(() => {
  dir = tmpDir("vdc-oldproject-")
  fs.mkdirSync(path.join(dir, ".git"))
  delete process.env.DEBEROPA_CONFIG_CONTENT
  initProject(dir)
  resetConfig()
})

test("D4: a project's old-named config file and folder are still read, and the new name wins", async () => {
  fs.writeFileSync(path.join(dir, `${OLD}.json`), JSON.stringify({ model: "old/model", small_model: "old/small" }))
  expect((await loadConfig()).config.model).toBe("old/model")

  fs.writeFileSync(path.join(dir, "deberopa.json"), JSON.stringify({ model: "new/model" }))
  resetConfig()
  const both = (await loadConfig()).config
  expect(both.model).toBe("new/model")
  expect(both.small_model).toBe("old/small")

  const sub = tmpDir("vdc-oldproject-dot-")
  fs.mkdirSync(path.join(sub, ".git"))
  fs.mkdirSync(path.join(sub, `.${OLD}`))
  fs.writeFileSync(path.join(sub, `.${OLD}`, `${OLD}.json`), JSON.stringify({ model: "dot/model" }))
  initProject(sub)
  resetConfig()
  expect((await loadConfig()).config.model).toBe("dot/model")
})

// ---- Opereta recognition ---------------------------------------------------------------------

test("the pre-rename info path and header are not recognised", async () => {
  const OLD_OS = ["dipar", "nux"].join("")
  const saved = process.env.DEBEROPA_DISABLE_LOCAL_DETECT
  delete process.env.DEBEROPA_DISABLE_LOCAL_DETECT
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url)
      const headers = { [`x-${OLD_OS}`]: "0.5.3" }
      if (url.pathname === `/${OLD_OS}/info`) return Response.json({ [OLD_OS]: "0.5.3", server: "running", slots: 4, ctx_per_slot: 4096 }, { headers })
      if (url.pathname === "/props") return Response.json({ default_generation_settings: { n_ctx: 8192 } }, { headers })
      if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "m" }] }, { headers })
      return new Response("nf", { status: 404, headers })
    },
  })
  try {
    const dead = "http://127.0.0.1:9"
    const base = `http://127.0.0.1:${server.port}`
    const [found] = await detectLocalServers({ llamacpp: base, ollama: dead, lmstudio: dead, vllm: dead })
    expect(found).toBeDefined()
    expect(found!.opereta).toBeUndefined()
    expect(Object.values(found!.models)[0]!.details).toBeUndefined()
  } finally {
    server.stop(true)
    if (saved !== undefined) process.env.DEBEROPA_DISABLE_LOCAL_DETECT = saved
  }
})
