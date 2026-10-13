import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Paths } from "../src/global"
import { loadPlugins, pluginProblems, resetPlugins } from "../src/plugin"
import { toolsFor } from "../src/tool/registry"
import { getAgent } from "../src/agent/agent"
import { loadConfig } from "../src/config/config"
import { prompt } from "../src/session/prompt"
import { createSession, getMessages } from "../src/session/store"
import { messageText, type ToolPart } from "../src/session/message"
import { endProject, mockConfig, reply, startMockLLM, tmpDir, useProject, type MockLLM } from "./helpers"

let mock: MockLLM
let dir: string
const savedTrust = process.env.VEDECAPS_TRUST_PROJECT

beforeAll(() => {
  mock = startMockLLM()
})
afterAll(() => {
  mock.stop()
  endProject()
  if (savedTrust !== undefined) process.env.VEDECAPS_TRUST_PROJECT = savedTrust
})
beforeEach(() => {
  dir = tmpDir()
  mock.reset()
  fs.mkdirSync(path.join(dir, ".git"))
  fs.mkdirSync(path.join(dir, ".vedecaps", "plugin"), { recursive: true })
  process.env.VEDECAPS_TRUST_PROJECT = "1"
})
afterEach(() => {
  fs.rmSync(path.join(Paths.config, "plugin"), { recursive: true, force: true })
})

const plugin = (name: string, source: string, where = path.join(dir, ".vedecaps", "plugin")) => {
  fs.mkdirSync(where, { recursive: true })
  const file = path.join(where, name)
  fs.writeFileSync(file, source)
  return file
}
const start = (extra: Record<string, unknown> = {}) => {
  useProject(dir, mockConfig(mock, extra))
  resetPlugins()
}
const agent = async () => (await getAgent("build"))!
const toolParts = async (id: string) => (await getMessages(id)).flatMap((m) => m.parts).filter((p): p is ToolPart => p.type === "tool")

test("a plugin's tool is offered to the model and runs", async () => {
  plugin(
    "shout.js",
    `export default async ({ directory }) => ({
      tool: {
        shout: {
          description: "Upper-case a string",
          parameters: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
          execute: async ({ text }, ctx) => ({ title: "shouted", output: text.toUpperCase() + " @" + (ctx.agent) }),
        },
      },
    })`,
  )
  start()
  expect((await loadPlugins()).map((p) => p.name)).toEqual(["shout"])
  expect((await toolsFor(await agent())).map((t) => t.id)).toContain("shout")

  mock.queue(reply.tools([{ name: "shout", args: { text: "quiet" } }]), reply.text("done"))
  const session = await createSession()
  await prompt({ sessionID: session.id, text: "use the plugin" })
  const [call] = await toolParts(session.id)
  expect(call!.state.status).toBe("completed")
  expect((call!.state as any).output).toBe("QUIET @build")
})

test("before can rewrite arguments or veto, after can rewrite the result", async () => {
  fs.writeFileSync(path.join(dir, "a.txt"), "original\n")
  plugin(
    "guard.js",
    `export default () => ({
      "tool.execute.before": async ({ tool }, output) => {
        if (tool === "bash" && /rm -rf/.test(output.args.command)) throw new Error("rm -rf is not allowed here")
        if (tool === "read") output.args.filePath = "b.txt"
      },
      "tool.execute.after": async ({ tool }, output) => {
        if (tool === "read") output.output = output.output.replace("secret", "[hidden]")
      },
    })`,
  )
  fs.writeFileSync(path.join(dir, "b.txt"), "the secret word\n")
  start()
  mock.queue(
    reply.tools([
      { name: "bash", args: { command: "rm -rf /" }, id: "c1" },
      { name: "read", args: { filePath: "a.txt" }, id: "c2" },
    ]),
    reply.text("done"),
  )
  const session = await createSession()
  await prompt({ sessionID: session.id, text: "go" })
  const parts = await toolParts(session.id)
  const bash = parts.find((p) => p.tool === "bash")!
  expect(bash.state.status).toBe("error")
  expect((bash.state as any).error).toContain("Blocked by plugin guard: rm -rf is not allowed here")
  const read = parts.find((p) => p.tool === "read")!
  expect(read.state.status).toBe("completed")
  expect((read.state as any).input.filePath).toBe("b.txt")
  expect((read.state as any).output).toContain("the [hidden] word")
})

test("chat.system extends the system prompt and event sees bus events", async () => {
  plugin(
    "extras.mjs",
    `export const events = []
     export default () => ({
       "chat.system": async ({ agent, modelID }, output) => { output.system.push("PLUGIN-RULE for " + agent + " on " + modelID) },
       event: (e) => { globalThis.__vdcEvents = (globalThis.__vdcEvents ?? 0) + 1 },
     })`,
  )
  start()
  ;(globalThis as any).__vdcEvents = 0
  await loadPlugins()
  mock.queue(reply.text("ok"))
  const session = await createSession()
  await prompt({ sessionID: session.id, text: "hello" })
  const system = String(mock.requests[0].messages[0].content)
  expect(system).toContain("PLUGIN-RULE for build on mock-1")
  expect((globalThis as any).__vdcEvents).toBeGreaterThan(3)
})

test("a broken plugin is reported and the others still load", async () => {
  plugin("a-broken.js", `export default () => { throw new Error("boom at startup") }`)
  plugin("b-syntax.js", `export default (`)
  plugin("c-nofactory.js", `export const x = 1`)
  plugin("d-good.js", `export default () => ({ tool: { ping: { description: "p", parameters: { type: "object" }, execute: () => "pong" } } })`)
  start()
  expect((await loadPlugins()).map((p) => p.name)).toEqual(["d-good"])
  const problems = pluginProblems()
  expect(problems).toHaveLength(3)
  expect(problems.find((p) => p.file.endsWith("a-broken.js"))!.error).toContain("boom at startup")
  expect(problems.find((p) => p.file.endsWith("c-nofactory.js"))!.error).toContain("default export")
})

test("a throwing event or after hook never breaks the turn", async () => {
  plugin(
    "flaky.js",
    `export default () => ({
      event: () => { throw new Error("event boom") },
      "tool.execute.after": async () => { throw new Error("after boom") },
      "chat.system": async () => { throw new Error("system boom") },
    })`,
  )
  fs.writeFileSync(path.join(dir, "a.txt"), "x\n")
  start()
  mock.queue(reply.tools([{ name: "read", args: { filePath: "a.txt" } }]), reply.text("fine"))
  const session = await createSession()
  const result = await prompt({ sessionID: session.id, text: "go" })
  expect(messageText(result!)).toBe("fine")
  expect((await toolParts(session.id))[0]!.state.status).toBe("completed")
})

test("plugins in the user config directory and in the plugin setting load too", async () => {
  plugin("user.js", `export default () => ({ tool: { from_user: { description: "u", parameters: {}, execute: () => "u" } } })`, path.join(Paths.config, "plugin"))
  const custom = plugin("anywhere.js", `export default () => ({ tool: { from_config: { description: "c", parameters: {}, execute: () => "c" } } })`, path.join(dir, "tools"))
  start({ plugin: [path.relative(dir, custom), "missing.js"] })
  const loaded = await loadPlugins()
  expect(loaded.map((p) => `${p.name}:${p.source}`).sort()).toEqual(["anywhere:config", "user:user"])
  expect(pluginProblems().map((p) => p.file)).toEqual(["missing.js"])
})

test("an untrusted project's plugins are not run", async () => {
  plugin("evil.js", `export default () => { globalThis.__vdcEvil = true; return {} }`)
  delete process.env.VEDECAPS_TRUST_PROJECT
  ;(globalThis as any).__vdcEvil = false
  start()
  expect(await loadPlugins()).toEqual([])
  expect((globalThis as any).__vdcEvil).toBe(false)
  const loaded = await loadConfig()
  expect(loaded.blocked.join("\n")).toContain("plugin/")
  expect(loaded.blocked.join("\n")).toContain("1 plugin file")
})
