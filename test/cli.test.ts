import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { mockConfig, reply, startMockLLM, tmpDir, type MockLLM } from "./helpers"

let mock: MockLLM
let home: string
let dir: string
const entry = path.join(import.meta.dir, "..", "src", "index.ts")

beforeAll(() => {
  mock = startMockLLM()
})
afterAll(() => mock.stop())
beforeEach(() => {
  mock.reset()
  home = tmpDir("vdc-clihome-")
  dir = tmpDir("vdc-cliproj-")
})

async function cli(args: string[], opts: { stdin?: string; config?: Record<string, unknown> | false; env?: Record<string, string> } = {}) {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    DEBEROPA_HOME: home,
    DEBEROPA_DISABLE_MODELS_FETCH: "1",
    DEBEROPA_CONFIG_CONTENT: JSON.stringify(opts.config === false ? {} : (opts.config ?? mockConfig(mock))),
    ...opts.env,
  }
  const proc = Bun.spawn([process.execPath, entry, ...args], {
    cwd: dir,
    env,
    stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { stdout, stderr, code }
}

test("--version and --help", async () => {
  expect((await cli(["--version"])).stdout.trim()).toBe(require("../package.json").version)
  const help = await cli(["--help"])
  expect(help.code).toBe(0)
  expect(help.stdout).toContain("deberopa run")
  const runHelp = await cli(["run", "--help"])
  expect(runHelp.stdout).toContain("--dangerously-skip-permissions")
  const unknown = await cli(["frobnicate"])
  expect(unknown.code).toBe(2)
  expect(unknown.stderr).toContain("Unknown command")
})

test("run streams the answer to stdout", async () => {
  mock.queue(reply.text("The answer is 42."))
  const r = await cli(["run", "what", "is", "the", "answer"])
  expect(r.code).toBe(0)
  expect(r.stdout).toBe("The answer is 42.\n")
  expect(mock.requests[0].messages.at(-1).content).toBe("what is the answer")
})

test("run reads piped stdin and appends it to the message", async () => {
  mock.queue(reply.text("ok"))
  const r = await cli(["run", "summarise"], { stdin: "piped content here" })
  expect(r.code).toBe(0)
  const last = mock.requests[0].messages.at(-1).content
  expect(last).toContain("summarise")
  expect(last).toContain("piped content here")
})

test("tool activity goes to stderr, text to stdout", async () => {
  fs.writeFileSync(path.join(dir, "x.txt"), "hello file")
  mock.queue(reply.tools([{ name: "read", args: { filePath: path.join(dir, "x.txt") } }]), reply.text("It says hello."))
  const r = await cli(["run", "read x.txt"])
  expect(r.code).toBe(0)
  expect(r.stdout).toBe("It says hello.\n")
  expect(r.stderr).toContain("read x.txt")
})

test("--format json emits an event stream", async () => {
  mock.queue(reply.text("json answer"))
  const r = await cli(["run", "--format", "json", "hi"])
  expect(r.code).toBe(0)
  const events = r.stdout.trim().split("\n").map((l) => JSON.parse(l))
  expect(events.some((e) => e.type === "text" && e.part.text === "json answer")).toBe(true)
  expect(events.at(-1).type).toBe("step_finish")
})

test("provider errors give a non-zero exit code", async () => {
  mock.queue(reply.error(401, "invalid api key"))
  const r = await cli(["run", "hi"])
  expect(r.code).toBe(1)
  expect(r.stderr).toContain("invalid api key")
})

test("permission asks are rejected unless --dangerously-skip-permissions", async () => {
  const target = path.join(dir, "out.txt")
  const config = mockConfig(mock, { permission: { edit: "ask" } })
  mock.queue(reply.tools([{ name: "write", args: { filePath: target, content: "x" } }]), reply.text("done"))
  const denied = await cli(["run", "write it"], { config })
  expect(denied.code).toBe(1)
  expect(denied.stderr).toContain("permission denied")
  expect(fs.existsSync(target)).toBe(false)

  mock.reset()
  mock.queue(reply.tools([{ name: "write", args: { filePath: target, content: "x" } }]), reply.text("done"))
  const allowed = await cli(["run", "--dangerously-skip-permissions", "write it"], { config })
  expect(allowed.code).toBe(0)
  expect(fs.readFileSync(target, "utf8")).toBe("x")
})

test("--continue resumes the previous session", async () => {
  mock.queue(reply.text("first"))
  await cli(["run", "one"])
  mock.queue(reply.text("second"))
  const r = await cli(["run", "--continue", "two"])
  expect(r.code).toBe(0)
  const roles = mock.requests[1].messages.map((m: any) => m.role)
  expect(roles.filter((x: string) => x === "user")).toHaveLength(2)
})

test("auth login via stdin, list, logout", async () => {
  const noCreds = { config: false as const }
  const login = await cli(["auth", "login", "openrouter"], { ...noCreds, stdin: "sk-test-not-a-real-key\n" })
  expect(login.code).toBe(0)
  const stored = JSON.parse(fs.readFileSync(path.join(home, "data", "auth.json"), "utf8"))
  expect(stored.openrouter.key).toBe("sk-test-not-a-real-key")
  const list = await cli(["auth", "list"], noCreds)
  expect(list.stdout).toContain("OpenRouter")
  expect(list.stdout).not.toContain("sk-test-not-a-real-key")
  const out = await cli(["auth", "logout", "openrouter"], noCreds)
  expect(out.code).toBe(0)
  expect((await cli(["auth", "logout", "openrouter"], noCreds)).code).toBe(1)
})

test("models, agent list/create, session list, export/import, stats, debug", async () => {
  const models = await cli(["models"])
  expect(models.stdout).toContain("mock/mock-1")

  const agents = await cli(["agent", "list"])
  expect(agents.stdout).toContain("build")
  expect(agents.stdout).toContain("explore")
  const created = await cli(["agent", "create", "--name", "docs", "--mode", "subagent", "--description", "Writes docs"])
  expect(created.code).toBe(0)
  expect(fs.readFileSync(path.join(dir, ".deberopa", "agent", "docs.md"), "utf8")).toContain("mode: subagent")

  mock.queue(reply.text("hello there"))
  await cli(["run", "greet"])
  const sessions = await cli(["session", "list", "--format", "json"])
  const list = JSON.parse(sessions.stdout)
  expect(list).toHaveLength(1)

  const exported = await cli(["export", "--format", "markdown"])
  expect(exported.stdout).toContain("hello there")
  const json = await cli(["export", list[0].id])
  const file = path.join(dir, "export.json")
  fs.writeFileSync(file, json.stdout)
  const imported = await cli(["import", file])
  expect(imported.code).toBe(0)
  expect(imported.stdout).toContain("Imported as")
  expect((await cli(["session", "list", "--format", "json"])).stdout.includes("fork")).toBe(false)
  expect(JSON.parse((await cli(["session", "list", "--format", "json"])).stdout)).toHaveLength(2)

  const stats = await cli(["stats"])
  expect(stats.stdout).toContain("Sessions   2")
  const debug = await cli(["debug"])
  expect(debug.stdout).toContain("Providers with credentials")
  expect(debug.stdout).toContain("mock")

  const del = await cli(["session", "delete", list[0].id])
  expect(del.code).toBe(0)
})

test("mcp add / list / remove", async () => {
  const add = await cli(["mcp", "add", "echo", "--", "node", "server.js"], { config: false })
  expect(add.code).toBe(0)
  const cfg = JSON.parse(fs.readFileSync(path.join(home, "config", "deberopa.json"), "utf8"))
  expect(cfg.mcp.echo).toEqual({ type: "local", command: ["node", "server.js"] })
  expect(cfg.$schema).toContain("config.schema.json")
  const rm = await cli(["mcp", "remove", "echo"], { config: false })
  expect(rm.code).toBe(0)
})
