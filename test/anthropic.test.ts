import { afterAll, beforeAll, expect, test } from "bun:test"
import { streamAnthropic, thinkingMode, __test } from "../src/provider/anthropic"
import { ProviderError, type Model, type ProviderInfo, type StreamEvent, type StreamInput } from "../src/provider/types"

const model = (id: string): Model => ({
  id,
  providerID: "anthropic",
  name: id,
  limit: { context: 1_000_000, output: 128_000 },
  cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  reasoning: true,
  toolCall: true,
  attachment: true,
  temperature: false,
})

let server: ReturnType<typeof Bun.serve>
let requests: any[] = []
let respond: (body: any) => Response

const sse = (events: any[]) =>
  new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })

const start = (usage = { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 }) => ({
  type: "message_start",
  message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage },
})
const stop = (reason: string, output = 42) => [
  { type: "message_delta", delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: output } },
  { type: "message_stop" },
]

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = await req.json()
      requests.push({ body, headers: Object.fromEntries(req.headers), url: req.url })
      return respond(body)
    },
  })
})
afterAll(() => server.stop(true))

const provider = (): ProviderInfo => ({
  id: "anthropic",
  name: "Anthropic",
  protocol: "anthropic",
  baseURL: `http://127.0.0.1:${server.port}`,
  env: [],
  apiKey: "sk-test-not-a-real-key",
  source: "config",
  models: {},
})

const input = (extra: Partial<StreamInput> = {}): StreamInput => ({
  provider: provider(),
  model: model("claude-opus-5-5"),
  system: ["You are a test.", "Environment block."],
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] } }],
  ...extra,
})

async function collect(i: StreamInput): Promise<StreamEvent[]> {
  const out: StreamEvent[] = []
  for await (const event of streamAnthropic(i)) out.push(event)
  return out
}

test("thinking mode per model generation", () => {
  expect(thinkingMode("claude-3-5-sonnet-20241022")).toBe("none")
  expect(thinkingMode("claude-3-7-sonnet-20250219")).toBe("budget")
  expect(thinkingMode("claude-sonnet-4-5")).toBe("budget")
  expect(thinkingMode("claude-haiku-4-5")).toBe("budget")
  expect(thinkingMode("claude-opus-4-1")).toBe("budget")
  expect(thinkingMode("claude-sonnet-4-6")).toBe("adaptive")
  expect(thinkingMode("claude-opus-4-8")).toBe("adaptive")
  expect(thinkingMode("claude-opus-5-5")).toBe("adaptive")
  expect(thinkingMode("claude-haiku-5-5")).toBe("adaptive")
  expect(thinkingMode("claude-fable-5-1")).toBe("adaptive")
})

test("request shape for current models on the first-party API", () => {
  const first = { ...input(), provider: { ...provider(), baseURL: undefined } }
  const { params, betas } = __test.buildParams(first, true)
  expect(params.thinking).toEqual({ type: "adaptive", display: "summarized" })
  expect(params.output_config).toEqual({ effort: "high" })
  expect(params.temperature).toBeUndefined()
  expect(params.max_tokens).toBe(64_000)
  expect(params.fallbacks).toBe("default")
  expect(betas).toEqual(["server-side-fallback-2026-07-01"])
  expect(params.tools[0].eager_input_streaming).toBe(true)
  // cache breakpoints: end of the system prompt and the newest user turn
  expect(params.system.map((b: any) => !!b.cache_control)).toEqual([false, true])
  expect(params.messages.at(-1).content.at(-1).cache_control).toEqual({ type: "ephemeral" })

  const without = __test.buildParams(first, false)
  expect(without.params.fallbacks).toBeUndefined()
  expect(without.betas).toEqual([])
})

test("older and gateway requests stay conservative", () => {
  const legacy = __test.buildParams({ ...input(), model: model("claude-haiku-4-5"), temperature: 0.3 }, false)
  expect(legacy.params.thinking.type).toBe("enabled")
  expect(legacy.params.thinking.budget_tokens).toBeLessThan(legacy.params.max_tokens)
  expect(legacy.params.output_config).toBeUndefined()
  expect(legacy.betas).toEqual(["interleaved-thinking-2025-05-14"])
  const plain = __test.buildParams({ ...input(), model: { ...model("claude-3-5-haiku-20241022"), reasoning: false }, temperature: 0.3 }, false)
  expect(plain.params.thinking).toBeUndefined()
  expect(plain.params.temperature).toBe(0.3)
  // a custom base URL is not the first-party API: no eager streaming field
  expect(__test.buildParams(input(), false).params.tools[0].eager_input_streaming).toBeUndefined()
  // xhigh does not exist on the 4.6 models
  expect(__test.buildParams({ ...input(), model: model("claude-sonnet-4-6"), effort: "xhigh" }, false).params.output_config.effort).toBe("high")
})

test("streams thinking, text and a tool call, and keeps native blocks for replay", async () => {
  requests = []
  respond = () =>
    sse([
      start(),
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me look." } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-abc" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Reading " } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "the file." } },
      { type: "content_block_stop", index: 1 },
      { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "read", input: {} } },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"filePath":' } },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '"a.txt"}' } },
      { type: "content_block_stop", index: 2 },
      ...stop("tool_use"),
    ])
  const events = await collect(input())
  expect(events.filter((e) => e.type === "reasoning-delta").map((e: any) => e.text).join("")).toBe("Let me look.")
  expect(events.some((e) => e.type === "reasoning-end")).toBe(true)
  expect(events.filter((e) => e.type === "text-delta").map((e: any) => e.text).join("")).toBe("Reading the file.")
  const call = events.find((e) => e.type === "tool-call") as any
  expect(call).toMatchObject({ id: "toolu_1", name: "read", input: { filePath: "a.txt" } })
  expect(call.invalid).toBeUndefined()
  const finish = events.at(-1) as any
  expect(finish.type).toBe("finish")
  expect(finish.reason).toBe("tool-calls")
  expect(finish.usage).toEqual({ input: 12, output: 42, reasoning: 0, cacheRead: 100, cacheWrite: 7 })
  expect(finish.raw.map((b: any) => b.type)).toEqual(["thinking", "text", "tool_use"])
  expect(finish.raw[0].signature).toBe("sig-abc")
  expect(finish.raw[2].input).toEqual({ filePath: "a.txt" })

  const sent = requests[0]
  expect(sent.headers["x-api-key"]).toBe("sk-test-not-a-real-key")
  expect(sent.body.stream).toBe(true)
  expect(sent.body.tools[0].name).toBe("read")
})

test("native blocks are replayed only to the model that produced them", () => {
  const raw = [{ type: "thinking", thinking: "x", signature: "s" }, { type: "text", text: "hi" }, { type: "tool_use", id: "t1", name: "read", input: { filePath: "a" } }]
  const history: StreamInput["messages"] = [
    { role: "user", content: [{ type: "text", text: "go" }] },
    { role: "assistant", content: [{ type: "text", text: "hi" }, { type: "tool-call", id: "t1", name: "read", input: { filePath: "a" } }], raw: { providerID: "anthropic", modelID: "claude-opus-5-5", content: raw } },
    { role: "tool", results: [{ id: "t1", name: "read", output: "", isError: false }] },
  ]
  const same = __test.toMessages(input({ messages: history }))
  expect(same[1].content).toEqual(raw)
  expect(same[2].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "t1" })
  expect(same[2].content[0].content[0].text).toBe("(no output)")
  const other = __test.toMessages(input({ messages: history, model: model("claude-sonnet-5-5") }))
  expect(other[1].content.map((b: any) => b.type)).toEqual(["text", "tool_use"])
})

test("a call cut off by max_tokens never runs", async () => {
  respond = () =>
    sse([
      start(),
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_2", name: "read", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"filePath":"a.t' } },
      { type: "content_block_stop", index: 0 },
      ...stop("max_tokens"),
    ])
  const events = await collect(input())
  const call = events.find((e) => e.type === "tool-call") as any
  expect(call.invalid).toBeTruthy()
  expect((events.at(-1) as any).reason).toBe("length")
  expect((events.at(-1) as any).raw[0].input).toEqual({})
})

test("refusals and API errors are reported, not thrown away", async () => {
  respond = () => sse([start(), ...stop("refusal")])
  const refused = (await collect(input())).at(-1) as any
  expect(refused.reason).toBe("refusal")
  expect(refused.message).toBeTruthy()

  respond = () => Response.json({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, { status: 529 })
  const overloaded = await collect(input()).catch((e) => e)
  expect(overloaded).toBeInstanceOf(ProviderError)
  expect(overloaded.retryable).toBe(true)

  respond = () => Response.json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, { status: 401 })
  const auth = await collect(input()).catch((e) => e)
  expect(auth.kind).toBe("auth")
  expect(auth.retryable).toBe(false)

  respond = () => Response.json({ type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 1200000 tokens > 1000000 maximum" } }, { status: 400 })
  expect((await collect(input()).catch((e) => e)).kind).toBe("context-overflow")
})
