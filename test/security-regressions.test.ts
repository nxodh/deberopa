import { afterAll, beforeEach, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { initProject } from "../src/project"
import { loadConfig } from "../src/config/config"
import { getAgent } from "../src/agent/agent"
import { getCommand, runCommand } from "../src/command/command"
import { evaluate, replyPermission } from "../src/permission/permission"
import { subscribe } from "../src/util/bus"
import { startServer } from "../src/server/server"
import { createSession } from "../src/session/store"
import { ReadTool } from "../src/tool/read"
import { assertInsideProject, type ToolContext } from "../src/tool/tool"
import { importExport, parseExport } from "../src/session/export"
import { getMessages } from "../src/session/store"
import { shouldCompact } from "../src/session/compaction"
import { EMPTY_USAGE } from "../src/provider/types"
import { BashTool } from "../src/tool/bash"
import { loadPlugins } from "../src/plugin"
import { formatFile } from "../src/format/format"
import { offerInstall } from "../src/lsp"
import { endProject, mockConfig, resetAll, startMockLLM, tmpDir, useProject } from "./helpers"

const trust = process.env.DEBEROPA_TRUST_PROJECT
beforeEach(() => { endProject(); delete process.env.DEBEROPA_TRUST_PROJECT })
afterAll(() => { endProject(); if (trust !== undefined) process.env.DEBEROPA_TRUST_PROJECT = trust })

test("untrusted project substitutions and Markdown code cannot read files or override permissions", async () => {
  const dir = tmpDir()
  const outside = path.join(tmpDir(), "fake-note.txt")
  fs.writeFileSync(outside, "fixture-not-a-secret")
  fs.mkdirSync(path.join(dir, ".deberopa", "agent"), { recursive: true })
  fs.mkdirSync(path.join(dir, ".deberopa", "command"))
  fs.writeFileSync(path.join(dir, ".deberopa", "agent", "build.md"), "---\npermission:\n  lsp_install: allow\n---\nIgnored\n")
  fs.writeFileSync(path.join(dir, ".deberopa", "command", "sneaky.md"), "!`echo should-not-run`")
  fs.writeFileSync(path.join(dir, "deberopa.json"), JSON.stringify({ agent: { probe: { prompt: `{file:${outside}}` } }, command: { sneaky: { template: "!`echo should-not-run`" } }, server: { hostname: "0.0.0.0" } }))
  initProject(dir)
  resetAll()
  const loaded = await loadConfig()
  expect(loaded.trusted).toBe(false)
  expect(loaded.config.agent?.probe?.prompt).not.toContain("fixture-not-a-secret")
  expect(loaded.blocked.join(" ")).toContain("substitutions")
  expect(loaded.config.server).toBeUndefined()
  expect(evaluate((await getAgent("build"))!.permission, "lsp_install", "typescript")).toBe("ask")
  expect(await getCommand("sneaky")).toBeUndefined()
})

test("command substitutions honour the selected agent's shell denial", async () => {
  const mock = startMockLLM()
  const dir = tmpDir()
  const marker = path.join(dir, "marker")
  useProject(dir, mockConfig(mock, { permission: { bash: "deny" }, command: { probe: { template: `!\`echo executed\`` } } }))
  const session = await createSession()
  try {
    await expect(runCommand({ sessionID: session.id, name: "probe" })).rejects.toThrow("Permission denied")
    expect(mock.requests.length).toBe(0)
    expect(fs.existsSync(marker)).toBe(false)
  } finally { mock.stop() }
})

test("symlinks cannot disguise external paths or .env permissions", async () => {
  const root = tmpDir()
  const outside = tmpDir()
  const target = path.join(outside, ".env")
  fs.writeFileSync(target, "FAKE=fixture")
  const link = path.join(root, "innocent.txt")
  try { fs.symlinkSync(target, link) } catch (err) {
    if (process.platform === "win32" && (err as NodeJS.ErrnoException).code === "EPERM") return
    throw err
  }
  const requests: any[] = []
  const ctx: ToolContext = { sessionID: "fixture", messageID: "", callID: "", agent: "build", abort: new AbortController().signal,
    directory: root, worktree: root, metadata: () => {}, ask: async (request) => { requests.push(request) } }
  await ReadTool.execute({ filePath: link }, ctx)
  // Bun's synchronous Windows realpath can retain a DOS short-name ancestor.
  // Use the asynchronous canonical path, as the actual file permission check does.
  const resolved = await fs.promises.realpath(target)
  expect(requests.find((r) => r.permission === "external_directory").patterns).toContain(resolved)
  expect(requests.find((r) => r.permission === "read").patterns).toContain(resolved)
  fs.symlinkSync(outside, path.join(root, "linked-dir"), "junction")
  requests.length = 0
  await assertInsideProject(ctx, path.join(root, "linked-dir", "new.txt"))
  expect(requests[0].permission).toBe("external_directory")
})

test("HTTP API rejects cross-origin requests and unauthenticated network binding", async () => {
  expect(() => startServer({ hostname: "0.0.0.0", port: 0 })).toThrow("requires")
  const server = startServer({ port: 0 })
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/session`, { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" })
    expect(response.status).toBe(403)
    const rebound = await fetch(`http://127.0.0.1:${server.port}/health`, { headers: { host: "attacker.example" } })
    expect(rebound.status).toBe(403)
    const oversized = await fetch(`http://127.0.0.1:${server.port}/session`, { method: "POST", body: "x".repeat(1024 * 1024 + 1) })
    expect(oversized.status).toBe(413)
  } finally { server.stop(true) }
})

test("untrusted projects cannot shadow global plugins or trigger automatic code installation", async () => {
  const root = tmpDir()
  const name = "fixture-global-plugin.js"
  fs.writeFileSync(path.join(root, name), 'throw new Error("project plugin executed")')
  useProject(root, { plugin: [name] })
  const plugins = await loadPlugins()
  expect(plugins.some((p) => p.file === path.join(root, name))).toBe(false)
  const file = path.join(root, "fixture.ts")
  fs.writeFileSync(file, "const x=1")
  expect(await formatFile(file)).toBeUndefined()
  let asked = false
  expect(await offerInstall(file, { ask: async () => { asked = true } })).toBeUndefined()
  expect(asked).toBe(false)
})

test("prefix shell allowances do not cover substitutions, redirection, or executable git flags", async () => {
  for (const command of ["git status $(echo ignored)", "git diff --output=fixture", "git diff --ext-diff", "git diff > fixture"]) {
    let patterns: string[] = []
    const ctx: ToolContext = { sessionID: "fixture", messageID: "", callID: "", agent: "plan", abort: new AbortController().signal,
      directory: tmpDir(), worktree: tmpDir(), metadata: () => {}, ask: async (request) => { patterns = request.patterns; throw new Error("blocked before execution") } }
    await expect(BashTool.execute({ command }, ctx)).rejects.toThrow("blocked before execution")
    expect(patterns).toContain("[shell expansion or redirection]")
  }
})

test("plan and explore never auto-approve shell programs as read-only", async () => {
  useProject(tmpDir())
  for (const name of ["plan", "explore"]) {
    const rules = (await getAgent(name))!.permission
    for (const command of ["cat .env", "git diff", "find . -exec echo fixture ;", "rg --pre fixture ."]) {
      expect(evaluate(rules, "bash", command)).toBe("ask")
    }
  }
})

test("small context windows leave room for input instead of compacting every turn", () => {
  for (const context of [8192, 16384]) {
    const model = { limit: { context, output: 16384 } } as any
    expect(shouldCompact({ ...EMPTY_USAGE, input: 100, output: 10 }, model)).toBe(false)
    expect(shouldCompact({ ...EMPTY_USAGE, input: context - 100 }, model)).toBe(true)
  }
})

test("imported local snapshots and part IDs cannot restore or write foreign files", async () => {
  useProject(tmpDir())
  const data: any = { format: "deberopa-session", version: 1, info: { title: "Imported", time: {} }, messages: [{
    id: "../../escape", role: "assistant", agent: "build", time: { created: 1 }, providerID: "mock", modelID: "m", tokens: EMPTY_USAGE,
    parts: [{ id: "../../escape", type: "patch", hash: "fake", files: ["outside.txt"] }, { id: "../../escape", type: "text", text: "safe" }],
  }] }
  const session = await importExport(parseExport(JSON.stringify(data)))
  const message = (await getMessages(session.id))[0]!
  expect(message.parts.some((p) => p.type === "patch")).toBe(false)
  expect(message.parts[0]!.id).not.toContain("..")
})
