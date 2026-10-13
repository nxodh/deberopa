import { afterAll, expect, test } from "bun:test"
import path from "node:path"
import { connectMcp, createSSEParser, McpError } from "../src/mcp/client"

const fixture = path.join(import.meta.dir, "fixtures", "mcp-echo-server.ts")

test("stdio: tools, pagination, error results, prompts and close", async () => {
  const client = await connectMcp("echo", { type: "local", command: [process.execPath, fixture] })
  try {
    expect(client.serverInfo?.name).toBe("echo-fixture")
    expect((await client.listTools()).map((t) => t.name)).toEqual(["echo", "fail"])

    const echo = await client.callTool("echo", { text: "hello" })
    expect(echo.content).toEqual([{ type: "text", text: "hello" }])
    expect(echo.isError).toBeFalsy()

    const failed = await client.callTool("fail", {})
    expect(failed.isError).toBe(true)

    expect((await client.listPrompts()).map((p) => p.name)).toEqual(["greet"])
    const prompt = await client.getPrompt("greet", { name: "Ada" })
    expect(prompt.messages[0]?.content.text).toBe("Hello, Ada!")
  } finally {
    await client.close()
  }
}, 20000)

test("stdio: spawn failure rejects with McpError", async () => {
  await expect(connectMcp("ghost", { type: "local", command: ["definitely-not-a-real-binary-xyz"] })).rejects.toBeInstanceOf(McpError)
}, 20000)

type Seen = { method: string; sessionId: string | null; protocol: string | null; custom: string | null }
const seen: Seen[] = []
let deletedSession: string | null = null

const http = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  idleTimeout: 255,
  async fetch(req) {
    if (req.method === "DELETE") {
      deletedSession = req.headers.get("mcp-session-id")
      return new Response(null, { status: 204 })
    }
    const msg = (await req.json()) as { id?: number | string; method?: string; params?: any }
    // Replies from the client to a server request carry no method.
    if (msg.method === undefined) return new Response(null, { status: 202 })
    seen.push({
      method: msg.method,
      sessionId: req.headers.get("mcp-session-id"),
      protocol: req.headers.get("mcp-protocol-version"),
      custom: req.headers.get("x-test"),
    })
    switch (msg.method) {
      case "initialize":
        return Response.json(
          {
            jsonrpc: "2.0",
            id: msg.id,
            result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "http-fixture", version: "1.0.0" } },
          },
          { headers: { "Mcp-Session-Id": "session-abc" } },
        )
      case "notifications/initialized":
        return new Response(null, { status: 202 })
      case "tools/list":
        return Response.json({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "remote-echo", inputSchema: { type: "object" } }] } })
      case "tools/call": {
        const json = JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: { content: [{ type: "text", text: `remote:${msg.params.arguments.text}` }] },
        })
        // Split the payload over two data lines; SSE joins them with a newline, which is still valid JSON.
        const cut = json.indexOf(",")
        const body = `event: message\n: keep-alive\ndata: ${json.slice(0, cut)}\ndata: ${json.slice(cut)}\n\n`
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } })
      }
      default:
        return Response.json({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "nope" } })
    }
  },
})

const locked = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: () => new Response("unauthorized", { status: 401 }),
})

test("http: session id and protocol version are sent back, JSON and SSE responses parsed", async () => {
  const client = await connectMcp("remote", {
    type: "remote",
    url: `http://127.0.0.1:${http.port}/mcp`,
    headers: { "X-Test": "yes" },
  })
  try {
    expect(client.serverInfo?.name).toBe("http-fixture")
    expect((await client.listTools()).map((t) => t.name)).toEqual(["remote-echo"])
    const res = await client.callTool("remote-echo", { text: "x" })
    expect(res.content).toEqual([{ type: "text", text: "remote:x" }])
  } finally {
    await client.close()
  }

  expect(deletedSession).toBe("session-abc")
  expect(seen[0]?.method).toBe("initialize")
  expect(seen[0]?.sessionId).toBeNull()
  const later = seen.slice(1)
  expect(later.length).toBeGreaterThan(0)
  expect(later.every((s) => s.sessionId === "session-abc")).toBe(true)
  expect(later.every((s) => s.protocol === "2025-06-18")).toBe(true)
  expect(later.every((s) => s.custom === "yes")).toBe(true)
}, 20000)

test("http: 401 surfaces an authentication error", async () => {
  const err = await connectMcp("locked", { type: "remote", url: `http://127.0.0.1:${locked.port}/mcp` }).catch((e: unknown) => e)
  expect(err).toBeInstanceOf(McpError)
  expect((err as McpError).message).toContain('MCP server "locked" requires authentication (HTTP 401)')
  expect((err as McpError).message).toContain("mcp.locked.headers")
}, 20000)

// Legacy HTTP+SSE: POST to the SSE URL is refused, so the client falls back to GET + endpoint event.
const enc = new TextEncoder()
let legacyStream: ReadableStreamDefaultController<Uint8Array> | undefined
const legacy = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url)
    if (req.method === "GET" && url.pathname === "/sse") {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          legacyStream = controller
          controller.enqueue(enc.encode("event: endpoint\ndata: /messages?session=1\n\n"))
        },
      })
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } })
    }
    if (req.method === "POST" && url.pathname === "/sse") return new Response(null, { status: 405 })
    if (req.method === "POST" && url.pathname === "/messages") {
      const msg = (await req.json()) as { id?: number; method?: string }
      if (msg.id !== undefined) {
        const result =
          msg.method === "initialize"
            ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "legacy-fixture" } }
            : { tools: [{ name: "legacy-tool", inputSchema: { type: "object" } }] }
        legacyStream?.enqueue(enc.encode(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n\n`))
      }
      return new Response(null, { status: 202 })
    }
    return new Response("not found", { status: 404 })
  },
})

test("legacy SSE: falls back to GET stream with endpoint event", async () => {
  const client = await connectMcp("legacy", { type: "remote", url: `http://127.0.0.1:${legacy.port}/sse` })
  try {
    expect(client.serverInfo?.name).toBe("legacy-fixture")
    expect((await client.listTools()).map((t) => t.name)).toEqual(["legacy-tool"])
  } finally {
    await client.close()
  }
}, 20000)

test("createSSEParser: split chunks, multi-line data, CRLF and comments", () => {
  const events: Array<{ event: string; data: string }> = []
  const parser = createSSEParser((e) => events.push({ event: e.event, data: e.data }))

  parser.feed(": a comment\r\nevent: endpoint\r\nda")
  parser.feed("ta: first\r\ndata: second\r\n\r")
  parser.feed("\n")
  expect(events).toEqual([{ event: "endpoint", data: "first\nsecond" }])

  // An event with no data lines is not dispatched; an event without an event field defaults to "message".
  parser.feed("event: noop\n\nda")
  parser.feed('ta: {"id":1}\n\n')
  expect(events).toEqual([
    { event: "endpoint", data: "first\nsecond" },
    { event: "message", data: '{"id":1}' },
  ])
})

afterAll(() => {
  http.stop(true)
  locked.stop(true)
  legacy.stop(true)
})
