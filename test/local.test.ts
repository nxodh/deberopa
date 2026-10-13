import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { detectLocalServers, isLocalURL, ollamaBaseURL } from "../src/provider/local"
import { __test as ollama, streamOllama } from "../src/provider/ollama"
import { parseTextToolCalls, withCompat } from "../src/provider/compat"
import { streamModel } from "../src/provider/stream"
import { allProviders } from "../src/provider/provider"
import { useCompactPrompt, shortenDescription } from "../src/session/system"
import { prompt } from "../src/session/prompt"
import { createSession, getMessages } from "../src/session/store"
import { messageText, type ToolPart } from "../src/session/message"
import { ProviderError, type Model, type ProviderInfo, type StreamEvent, type StreamInput } from "../src/provider/types"
import { tmpDir, useProject } from "./helpers"

const model = (over: Partial<Model> = {}): Model => ({
  id: "qwen3:8b",
  providerID: "ollama",
  name: "qwen3:8b",
  limit: { context: 32768, output: 8192 },
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  reasoning: false,
  toolCall: true,
  attachment: false,
  temperature: true,
  ...over,
})

let server: ReturnType<typeof Bun.serve>
let base: string
let requests: { path: string; body: any }[] = []
let chat: (body: any) => Response | Promise<Response>

const ndjson = (lines: unknown[]) => new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n", { headers: { "content-type": "application/x-ndjson" } })
const done = (extra: Record<string, unknown> = {}) => ({ model: "qwen3:8b", message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 321, eval_count: 17, ...extra })

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      const body = req.method === "POST" ? await req.json().catch(() => ({})) : undefined
      requests.push({ path: url.pathname, body })
      if (url.pathname === "/api/tags") {
        return Response.json({
          models: [
            { name: "qwen3:8b", size: 5_200_000_000, details: { parameter_size: "8.2B", quantization_level: "Q4_K_M" } },
            { name: "llama3.2:1b", size: 1_300_000_000, details: { parameter_size: "1.2B", quantization_level: "Q8_0" } },
            { name: "nomic-embed-text:latest", size: 274_000_000, details: {} },
            { name: "llava:7b", size: 4_700_000_000, details: {} },
          ],
        })
      }
      if (url.pathname === "/api/show") {
        const table: Record<string, any> = {
          "qwen3:8b": { capabilities: ["completion", "tools", "thinking"], model_info: { "general.architecture": "qwen3", "qwen3.context_length": 40960 } },
          "llama3.2:1b": { capabilities: ["completion"], model_info: { "llama.context_length": 131072 } },
          "nomic-embed-text:latest": { capabilities: ["embedding"], model_info: { "nomic-bert.context_length": 2048 } },
          "llava:7b": { capabilities: ["completion", "vision", "tools"], model_info: { "llama.context_length": 4096 } },
        }
        return Response.json(table[body.model] ?? {})
      }
      if (url.pathname === "/api/chat") return chat(body)
      if (url.pathname === "/api/v0/models") {
        return Response.json({
          data: [
            { id: "qwen2.5-coder-7b-instruct", type: "llm", state: "loaded", max_context_length: 32768, loaded_context_length: 16384, capabilities: ["tool_use"], arch: "qwen2", quantization: "Q4_K_M" },
            { id: "text-embedding-nomic", type: "embeddings", state: "not-loaded", max_context_length: 2048 },
          ],
        })
      }
      if (url.pathname === "/props") return Response.json({ default_generation_settings: { n_ctx: 8192 }, model_alias: "gemma-3-4b" })
      if (url.pathname === "/v1/models") return Response.json({ object: "list", data: [{ id: "gemma-3-4b", object: "model" }] })
      return new Response("not found", { status: 404 })
    },
  })
  base = `http://127.0.0.1:${server.port}`
})
afterAll(() => server.stop(true))
beforeEach(() => {
  requests = []
})

const providerFor = (over: Partial<ProviderInfo> = {}): ProviderInfo => ({
  id: "ollama",
  name: "Ollama",
  protocol: "ollama",
  baseURL: base,
  env: [],
  source: "local",
  local: true,
  models: {},
  ...over,
})

const input = (over: Partial<StreamInput> = {}): StreamInput => ({
  provider: providerFor(),
  model: model(),
  system: ["system text"],
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  tools: [],
  ...over,
})

async function collect(gen: AsyncGenerator<StreamEvent>) {
  const events: StreamEvent[] = []
  for await (const e of gen) events.push(e)
  return events
}
const text = (events: StreamEvent[]) => events.filter((e) => e.type === "text-delta").map((e: any) => e.text).join("")
const reasoning = (events: StreamEvent[]) => events.filter((e) => e.type === "reasoning-delta").map((e: any) => e.text).join("")

test("what counts as a local address", () => {
  for (const url of ["http://localhost:11434", "http://127.0.0.1:1234/v1", "http://192.168.1.20:8080", "http://10.0.0.5", "http://172.20.0.1", "http://[::1]:8000", "http://gpu-box.local:8000"]) {
    expect(isLocalURL(url)).toBe(true)
  }
  for (const url of ["https://api.openai.com/v1", "http://8.8.8.8", "http://172.32.0.1", "https://example.com", "not a url", undefined]) {
    expect(isLocalURL(url as string)).toBe(false)
  }
})

test("OLLAMA_HOST in its different spellings", () => {
  expect(ollamaBaseURL("")).toBe("http://127.0.0.1:11434")
  expect(ollamaBaseURL("0.0.0.0:11434")).toBe("http://127.0.0.1:11434")
  expect(ollamaBaseURL("gpu-box")).toBe("http://gpu-box:11434")
  expect(ollamaBaseURL("http://10.0.0.7:9999")).toBe("http://10.0.0.7:9999")
})

test("detecting servers and reading each model's real capabilities", async () => {
  delete process.env.VEDECAPS_DISABLE_LOCAL_DETECT
  try {
    const servers = await detectLocalServers({ ollama: base, lmstudio: base, llamacpp: base, vllm: "http://127.0.0.1:9" })
    expect(servers.map((s) => s.id).sort()).toEqual(["llamacpp", "lmstudio", "ollama"])

    const o = servers.find((s) => s.id === "ollama")!
    expect(o.protocol).toBe("ollama")
    expect(Object.keys(o.models).sort()).toEqual(["llama3.2:1b", "llava:7b", "qwen3:8b"]) // the embedding model is not a chat model
    expect(o.models["qwen3:8b"]).toMatchObject({ context: 32768, maxContext: 40960, toolCall: true, reasoning: true, attachment: false })
    expect(o.models["llama3.2:1b"]).toMatchObject({ context: 32768, maxContext: 131072, toolCall: false })
    expect(o.models["llava:7b"]).toMatchObject({ context: 4096, attachment: true })
    expect(o.models["qwen3:8b"]!.details).toContain("Q4_K_M")

    const lm = servers.find((s) => s.id === "lmstudio")!
    expect(lm.baseURL).toBe(`${base}/v1`)
    expect(Object.keys(lm.models)).toEqual(["qwen2.5-coder-7b-instruct"])
    expect(lm.models["qwen2.5-coder-7b-instruct"]!.context).toBe(16384) // the loaded window, not the model's maximum

    const llama = servers.find((s) => s.id === "llamacpp")!
    expect(llama.models["gemma-3-4b"]!.context).toBe(8192)
  } finally {
    process.env.VEDECAPS_DISABLE_LOCAL_DETECT = "1"
  }
})

test("an unreachable server is simply absent", async () => {
  delete process.env.VEDECAPS_DISABLE_LOCAL_DETECT
  try {
    const started = Date.now()
    expect(await detectLocalServers({ ollama: "http://127.0.0.1:9", lmstudio: "http://127.0.0.1:9", llamacpp: "http://127.0.0.1:9", vllm: "http://127.0.0.1:9" })).toEqual([])
    expect(Date.now() - started).toBeLessThan(3000)
  } finally {
    process.env.VEDECAPS_DISABLE_LOCAL_DETECT = "1"
  }
})

test("the request asks for the context window explicitly", () => {
  const body = ollama.buildBody(input({ tools: [{ name: "read", description: "Read", parameters: { type: "object", properties: {} } }] })) as any
  expect(body.options.num_ctx).toBe(32768)
  expect(body.options.num_predict).toBe(8192)
  expect(body.stream).toBe(true)
  expect(body.keep_alive).toBe("30m")
  expect(body.tools[0].function.name).toBe("read")
  expect(body.think).toBeUndefined()

  const custom = ollama.buildBody(input({ model: model({ options: { num_ctx: 65536, temperature: 0.2, keep_alive: "5m" }, reasoning: true }) })) as any
  expect(custom.options.num_ctx).toBe(65536)
  expect(custom.options.temperature).toBe(0.2)
  expect(custom.keep_alive).toBe("5m")
  expect(custom.think).toBe(true)
  const oss = ollama.buildBody(input({ model: model({ id: "gpt-oss:20b", reasoning: true }), effort: "low" })) as any
  expect(oss.think).toBe("low")
})

test("tool calls and results round-trip in Ollama's message format", () => {
  const messages = ollama.toMessages(
    input({
      model: model({ attachment: true }),
      messages: [
        { role: "user", content: [{ type: "text", text: "read it" }, { type: "image", mime: "image/png", data: "AAAA" }] },
        { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "tool-call", id: "c1", name: "read", input: { filePath: "a.txt" } }] },
        { role: "tool", results: [{ id: "c1", name: "read", output: "" }] },
      ],
    }),
  )
  expect(messages[0]).toEqual({ role: "system", content: "system text" })
  expect(messages[1]).toEqual({ role: "user", content: "read it", images: ["AAAA"] })
  expect(messages[2]).toEqual({ role: "assistant", content: "ok", tool_calls: [{ function: { name: "read", arguments: { filePath: "a.txt" } } }] })
  expect(messages[3]).toEqual({ role: "tool", tool_name: "read", content: "(no output)" })
})

test("streams thinking, text and tool calls from /api/chat", async () => {
  chat = () =>
    ndjson([
      { message: { role: "assistant", content: "", thinking: "Let me " } },
      { message: { role: "assistant", content: "", thinking: "check." } },
      { message: { role: "assistant", content: "Reading " } },
      { message: { role: "assistant", content: "now." } },
      { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "read", arguments: { filePath: "a.txt" } } }] } },
      done(),
    ])
  const events = await collect(streamOllama(input({ tools: [{ name: "read", description: "Read", parameters: { type: "object" } }] })))
  expect(reasoning(events)).toBe("Let me check.")
  expect(text(events)).toBe("Reading now.")
  const call = events.find((e) => e.type === "tool-call") as any
  expect(call).toMatchObject({ name: "read", input: { filePath: "a.txt" } })
  const finish = events.at(-1) as any
  expect(finish).toMatchObject({ type: "finish", reason: "tool-calls", usage: { input: 321, output: 17 } })
  expect(requests.find((r) => r.path === "/api/chat")!.body.options.num_ctx).toBe(32768)
})

test("helpful errors for the failures people actually hit", async () => {
  chat = () => Response.json({ error: "model 'qwen3:8b' not found" }, { status: 404 })
  const missing = await collect(streamOllama(input())).catch((e) => e)
  expect(missing).toBeInstanceOf(ProviderError)
  expect(missing.message).toContain("ollama pull qwen3:8b")
  expect(missing.retryable).toBe(false)

  chat = () => Response.json({ error: "registry.ollama.ai/library/llama3.2:1b does not support tools" }, { status: 400 })
  expect((await collect(streamOllama(input())).catch((e) => e)).message).toContain("does not support tool calls")

  const offline = await collect(streamOllama(input({ provider: providerFor({ baseURL: "http://127.0.0.1:9" }) }))).catch((e) => e)
  expect(offline.message).toContain("ollama serve")
  expect(offline.retryable).toBe(false)
})

test("<think> tags become reasoning, even when split across chunks", async () => {
  async function* source(): AsyncGenerator<StreamEvent> {
    for (const t of ["<thi", "nk>I should ", "look at it.</th", "ink>\n\nThe answer", " is 4."]) yield { type: "text-delta", text: t }
    yield { type: "finish", reason: "stop", usage: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }
  }
  const events = await collect(withCompat(source(), { toolNames: [] }))
  expect(reasoning(events)).toBe("I should look at it.")
  expect(text(events)).toBe("The answer is 4.")
  expect(events.filter((e) => e.type === "reasoning-end")).toHaveLength(1)
})

test("a template that only emits the closing tag still separates the thought", async () => {
  async function* source(): AsyncGenerator<StreamEvent> {
    yield { type: "text-delta", text: "Okay, thinking it through</think>Final answer." }
    yield { type: "finish", reason: "stop", usage: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }
  }
  const events = await collect(withCompat(source(), { toolNames: [] }))
  expect(reasoning(events)).toBe("Okay, thinking it through")
  expect(text(events)).toBe("Final answer.")
})

test("tool calls written as text are recovered in every common dialect", () => {
  const names = ["read", "bash", "edit"]
  const hermes = parseTextToolCalls('Sure.\n<tool_call>\n{"name": "read", "arguments": {"filePath": "a.ts"}}\n</tool_call>', names)!
  expect(hermes.calls).toEqual([{ name: "read", args: { filePath: "a.ts" } }])
  expect(hermes.rest).toBe("Sure.")

  const qwen = parseTextToolCalls("<tool_call>\n<function=bash>\n<parameter=command>\nls -la\n</parameter>\n<parameter=timeout>\n5000\n</parameter>\n</function>\n</tool_call>", names)!
  expect(qwen.calls).toEqual([{ name: "bash", args: { command: "ls -la", timeout: 5000 } }])

  const mistral = parseTextToolCalls('[TOOL_CALLS][{"name": "bash", "arguments": {"command": "pwd"}}]', names)!
  expect(mistral.calls[0]).toEqual({ name: "bash", args: { command: "pwd" } })

  const fenced = parseTextToolCalls('```json\n{"name": "read", "parameters": {"filePath": "b.ts"}}\n```', names)!
  expect(fenced.calls).toEqual([{ name: "read", args: { filePath: "b.ts" } }])
  expect(fenced.rest).toBe("")

  const openai = parseTextToolCalls('{"function": {"name": "functions.edit", "arguments": "{\\"filePath\\": \\"c\\"}"}}', names)!
  expect(openai.calls).toEqual([{ name: "edit", args: { filePath: "c" } }])

  const many = parseTextToolCalls('<tool_call>{"name":"read","arguments":{"filePath":"1"}}</tool_call><tool_call>{"name":"read","arguments":{"filePath":"2"}}</tool_call>', names)!
  expect(many.calls.map((c) => c.args.filePath)).toEqual(["1", "2"])

  // not calls: unknown tool, ordinary JSON, ordinary prose
  expect(parseTextToolCalls('{"name": "launch_missiles", "arguments": {}}', names)).toBeUndefined()
  expect(parseTextToolCalls('{"id": 3, "title": "x"}', names)).toBeUndefined()
  expect(parseTextToolCalls("I will read the file next.", names)).toBeUndefined()
})

test("text that looks like a call is held back, and everything else streams straight through", async () => {
  const finish: StreamEvent = { type: "finish", reason: "stop", usage: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }
  async function* of(parts: string[]): AsyncGenerator<StreamEvent> {
    for (const t of parts) yield { type: "text-delta", text: t }
    yield finish
  }
  const names = ["read"]

  const call = await collect(withCompat(of(['{"name": "re', 'ad", "arguments": {"filePath": "x"}}']), { toolNames: names }))
  expect(text(call)).toBe("")
  expect(call.find((e) => e.type === "tool-call")).toMatchObject({ name: "read", input: { filePath: "x" } })
  expect((call.at(-1) as any).reason).toBe("tool-calls")

  const prose = await collect(withCompat(of(["Here is ", "the plan."]), { toolNames: names }))
  expect(text(prose)).toBe("Here is the plan.")
  expect(prose.filter((e) => e.type === "text-delta").length).toBe(2) // streamed, not buffered to the end

  const code = await collect(withCompat(of(["```ts\n", "const x = 1\n", "```"]), { toolNames: names }))
  expect(text(code)).toBe("```ts\nconst x = 1\n```")
  expect(code.filter((e) => e.type === "text-delta").length).toBe(3)

  const brace = await collect(withCompat(of(['{"not": "a call"}']), { toolNames: names }))
  expect(text(brace)).toBe('{"not": "a call"}') // held, found not to be a call, then released

  const afterProse = await collect(withCompat(of(["I'll read it.\n<tool_", 'call>{"name":"read","arguments":{"filePath":"y"}}</tool_call>']), { toolNames: names }))
  expect(text(afterProse)).toBe("I'll read it.\n")
  expect(afterProse.find((e) => e.type === "tool-call")).toMatchObject({ input: { filePath: "y" } })

  // a structured call from the server wins: the text is left alone
  async function* both(): AsyncGenerator<StreamEvent> {
    yield { type: "tool-call", id: "c", name: "read", input: {} }
    yield { type: "text-delta", text: '{"name": "read", "arguments": {}}' }
    yield finish
  }
  const structured = await collect(withCompat(both(), { toolNames: names }))
  expect(structured.filter((e) => e.type === "tool-call")).toHaveLength(1)
})

test("hosted providers skip the compatibility layer", async () => {
  chat = () => ndjson([{ message: { role: "assistant", content: '{"name": "read", "arguments": {}}' } }, done()])
  const local = await collect(streamModel(input({ tools: [{ name: "read", description: "r", parameters: { type: "object" } }] })))
  expect(local.some((e) => e.type === "tool-call")).toBe(true)
  const remote = await collect(streamModel(input({ provider: providerFor({ local: false }), tools: [{ name: "read", description: "r", parameters: { type: "object" } }] })))
  expect(remote.some((e) => e.type === "tool-call")).toBe(false)
})

test("small context windows switch to the compact prompt", () => {
  expect(useCompactPrompt({ local: true }, model({ limit: { context: 8192, output: 2048 } }))).toBe(true)
  expect(useCompactPrompt({ local: true }, model({ limit: { context: 32768, output: 2048 } }))).toBe(false)
  expect(useCompactPrompt({ local: false }, model({ limit: { context: 8192, output: 2048 } }))).toBe(false)
  expect(useCompactPrompt({ local: false }, model({ options: { compact_prompt: true } }))).toBe(true)
  expect(useCompactPrompt({ local: true }, model({ limit: { context: 4096, output: 1024 }, options: { compact_prompt: false } }))).toBe(false)
  expect(shortenDescription("Reads a file.\n\nUsage:\n- lots of detail")).toBe("Reads a file.")
})

test("end to end: a configured Ollama provider drives a full tool round trip", async () => {
  const dir = tmpDir()
  await Bun.write(`${dir}/hello.txt`, "greetings from a local file\n")
  useProject(dir, {
    model: "ollama/qwen3:8b",
    snapshot: false,
    provider: { ollama: { name: "Ollama", api: `${base}/v1`, models: { "qwen3:8b": { name: "Qwen3 8B", tool_call: true, limit: { context: 12000, output: 2000 } } } } },
  })
  const providers = await allProviders()
  // the OpenAI-style URL was upgraded to the native protocol, with the /v1 suffix removed
  expect(providers.ollama).toMatchObject({ protocol: "ollama", baseURL: base, local: true })

  let turn = 0
  const isTitle = (body: any) => String(body.messages?.[0]?.content ?? "").startsWith("You generate short titles")
  chat = (body) => {
    // title generation runs concurrently on the same server and is not part of the scripted turns
    if (isTitle(body)) return ndjson([{ message: { role: "assistant", content: "Local file" } }, done()])
    turn++
    if (turn === 1) {
      return ndjson([
        { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "read", arguments: { filePath: "hello.txt" } } }] } },
        done(),
      ])
    }
    const toolMessage = body.messages.find((m: any) => m.role === "tool")
    return ndjson([{ message: { role: "assistant", content: `It says: ${String(toolMessage?.content).includes("greetings") ? "greetings" : "?"}` } }, done()])
  }
  const session = await createSession()
  const result = await prompt({ sessionID: session.id, text: "read hello.txt" })
  expect(result && messageText(result)).toBe("It says: greetings")

  const chats = requests.filter((r) => r.path === "/api/chat" && !isTitle(r.body))
  expect(chats).toHaveLength(2)
  expect(chats[0]!.body.options.num_ctx).toBe(12000)
  // 12000 tokens is below the compact threshold, so the short prompt and short tool descriptions were used
  expect(chats[0]!.body.messages[0].content).toContain("You are Vedecaps")
  expect(chats[0]!.body.messages[0].content.length).toBeLessThan(2500)
  const parts = (await getMessages(session.id)).flatMap((m) => m.parts).filter((p): p is ToolPart => p.type === "tool")
  expect(parts[0]!.state.status).toBe("completed")
})
