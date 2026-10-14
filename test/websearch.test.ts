import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { WebSearchTool, resetWebSearch } from "../src/tool/websearch"
import { PermissionDeniedError, type PermissionRequest, type ToolContext } from "../src/tool/tool"
import { redact } from "../src/util/redact"
import { endProject, tmpDir, useProject } from "./helpers"

let server: ReturnType<typeof Bun.serve>
let seen: { url: string; method: string; body: any }[] = []
let searchResult: () => { content: any[]; isError?: boolean }
let asked: PermissionRequest[] = []
let deny = false

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body: any = req.method === "POST" ? await req.json() : undefined
      seen.push({ url: req.url, method: req.method, body })
      const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: body.id, result }, { headers: { "mcp-session-id": "s1" } })
      if (req.method !== "POST") return new Response(null, { status: 204 })
      if (body.method === "initialize") return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "exa-search-server", version: "0" } })
      if (body.method === "tools/call") return reply(searchResult())
      if (body.method === "tools/list") return reply({ tools: [] })
      return new Response(null, { status: 202 })
    },
  })
  process.env.DEBEROPA_EXA_URL = `http://127.0.0.1:${server.port}/mcp`
})
afterAll(() => {
  resetWebSearch()
  server.stop(true)
  delete process.env.DEBEROPA_EXA_URL
  delete process.env.EXA_API_KEY
  endProject()
})
beforeEach(() => {
  seen = []
  asked = []
  deny = false
  delete process.env.EXA_API_KEY
  resetWebSearch()
  useProject(tmpDir(), { snapshot: false })
  searchResult = () => ({ content: [{ type: "text", text: "Title: Bun 1.4\nURL: https://bun.sh/blog\nHighlights: fast" }] })
})

const ctx = (): ToolContext => ({
  sessionID: "s",
  messageID: "m",
  callID: "c",
  agent: "build",
  abort: new AbortController().signal,
  directory: process.cwd(),
  worktree: process.cwd(),
  ask: async (r) => {
    asked.push(r)
    if (deny) throw new PermissionDeniedError()
  },
  metadata: () => {},
})

test("asks first, then returns the page content", async () => {
  const result = await WebSearchTool.execute({ query: "bun release notes" }, ctx())
  expect(asked).toHaveLength(1)
  expect(asked[0]).toMatchObject({ permission: "websearch", patterns: ["exa"] })
  expect(result.output).toContain("https://bun.sh/blog")
  const call = seen.find((s) => s.body?.method === "tools/call")!.body.params
  expect(call.name).toBe("web_search_exa")
  // Exa requires an objective; it defaults to the query so the model need not repeat itself
  expect(call.arguments).toEqual({ query: "bun release notes", numResults: 8, objective: "bun release notes" })
})

test("result count is clamped and an explicit objective is passed through", async () => {
  await WebSearchTool.execute({ query: "q", numResults: 500, objective: "find the migration guide" }, ctx())
  const args = seen.find((s) => s.body?.method === "tools/call")!.body.params.arguments
  expect(args.numResults).toBe(20)
  expect(args.objective).toBe("find the migration guide")
})

test("a refused permission sends nothing", async () => {
  deny = true
  await expect(WebSearchTool.execute({ query: "secret project name" }, ctx())).rejects.toThrow()
  expect(seen).toHaveLength(0)
})

test("the free-tier limit is reported as an actionable error", async () => {
  searchResult = () => ({ content: [{ type: "text", text: "You've hit Exa's free MCP rate limit. To continue using without limits, create your own Exa API key." }] })
  const err = await WebSearchTool.execute({ query: "q" }, ctx()).catch((e) => e)
  expect(err.message).toContain("EXA_API_KEY")
})

test("an API key is sent as a query parameter and scrubbed from logs", async () => {
  process.env.EXA_API_KEY = "exa-test-not-a-real-key-123456"
  resetWebSearch()
  await WebSearchTool.execute({ query: "q" }, ctx())
  // (the previous test's connection is closed with a DELETE that may arrive first)
  expect(seen.find((s) => s.body?.method === "initialize")!.url).toContain("exaApiKey=exa-test-not-a-real-key-123456")
  expect(redact("failed: https://mcp.exa.ai/mcp?exaApiKey=exa-test-not-a-real-key-123456")).not.toContain("exa-test-not-a-real-key")
})

test("empty results and server-reported errors", async () => {
  searchResult = () => ({ content: [] })
  expect((await WebSearchTool.execute({ query: "q" }, ctx())).output).toBe("No results found.")
  searchResult = () => ({ content: [{ type: "text", text: "upstream failed" }], isError: true })
  await expect(WebSearchTool.execute({ query: "q" }, ctx())).rejects.toThrow("upstream failed")
  await expect(WebSearchTool.execute({ query: "   " }, ctx())).rejects.toThrow("empty")
})
