import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import { detectLocalServers, lastDetectFailures, localAPIKey, parseDiparnuxInfo, setDefaultEndpoints } from "../src/provider/local"
import { allProviders } from "../src/provider/provider"
import { checkToolCalling } from "../src/provider/toolcheck"
import { runLocalDebug } from "../src/cli/commands/local-debug"
import { redact } from "../src/util/redact"
import { endProject, tmpDir, useProject } from "./helpers"

const KEY = "dpx-test-not-a-real-key-0123456789"

interface Behaviour {
  /** The bearer value the server demands on /props, /v1/models and /v1/chat/completions. */
  needKey?: string
  header?: string
  info?: unknown | "404"
  propsCtx?: number
  models?: string[]
  chat?: (body: any) => Response | Promise<Response>
  redirectProps?: string
}
let behaviour: Behaviour = {}
let seen: { path: string; auth?: string; method: string }[] = []
let server: ReturnType<typeof Bun.serve>
let base: string
const dead = "http://127.0.0.1:9"

const json = (data: unknown, headers: Record<string, string> = {}) => Response.json(data, { headers })

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      const auth = req.headers.get("authorization") ?? undefined
      seen.push({ path: url.pathname, auth, method: req.method })
      const extra: Record<string, string> = behaviour.header ? { "x-diparnux": behaviour.header } : {}
      if (url.pathname === "/diparnux/info") return behaviour.info === undefined || behaviour.info === "404" ? new Response("not found", { status: 404 }) : json(behaviour.info, extra)
      if (behaviour.redirectProps && url.pathname === "/props") return Response.redirect(behaviour.redirectProps, 302)
      const guarded = ["/props", "/v1/models", "/v1/chat/completions"].includes(url.pathname)
      if (guarded && behaviour.needKey && auth !== `Bearer ${behaviour.needKey}`) return new Response("unauthorized", { status: 401, headers: extra })
      if (url.pathname === "/props") return json({ default_generation_settings: { n_ctx: behaviour.propsCtx ?? 32768 } }, extra)
      if (url.pathname === "/v1/models") return json({ data: (behaviour.models ?? ["qwen2.5-coder-7b-instruct-q4_k_m.gguf"]).map((id) => ({ id })) }, extra)
      if (url.pathname === "/v1/chat/completions" && behaviour.chat) return behaviour.chat(await req.json())
      return new Response("not found", { status: 404 })
    },
  })
  base = `http://127.0.0.1:${server.port}`
})
afterAll(() => {
  server.stop(true)
  endProject()
})

const savedEnv = { ...process.env }
beforeEach(() => {
  behaviour = {}
  seen = []
  delete process.env.VEDECAPS_DISABLE_LOCAL_DETECT
  delete process.env.DIPARNUX_API_KEY
  delete process.env.LLAMA_API_KEY
})
afterEach(() => {
  process.env.VEDECAPS_DISABLE_LOCAL_DETECT = "1"
  delete process.env.DIPARNUX_API_KEY
  delete process.env.LLAMA_API_KEY
  setDefaultEndpoints(undefined)
  void savedEnv
})

const detect = () => detectLocalServers({ llamacpp: base, ollama: dead, lmstudio: dead, vllm: dead })
const goodInfo = { diparnux: "0.5.3", server: "running", model: "qwen2.5-coder-7b-instruct-q4_k_m.gguf", ctx_per_slot: 16384, slots: 2 }

test("T1.1 a server that wants a key is reported, not silently missing", async () => {
  behaviour = { needKey: KEY }
  expect(await detect()).toEqual([])
  expect(lastDetectFailures()).toEqual([{ id: "llamacpp", baseURL: base, status: 401 }])

  process.env.DIPARNUX_API_KEY = KEY
  const servers = await detect()
  expect(servers.map((s) => s.id)).toEqual(["llamacpp"])
  expect(lastDetectFailures()).toEqual([])
})

test("T1.2 the key is sent exactly as a bearer token, and never to /diparnux/info", async () => {
  behaviour = { needKey: KEY, info: goodInfo }
  process.env.LLAMA_API_KEY = KEY
  await detect()
  const guarded = seen.filter((s) => s.path !== "/diparnux/info")
  expect(guarded.length).toBeGreaterThan(0)
  for (const s of guarded) expect(s.auth).toBe(`Bearer ${KEY}`)
  expect(seen.filter((s) => s.path === "/diparnux/info").every((s) => s.auth === undefined)).toBe(true)
})

test("DIPARNUX_API_KEY wins over LLAMA_API_KEY; blanks are ignored", () => {
  expect(localAPIKey({ DIPARNUX_API_KEY: "a-key-value", LLAMA_API_KEY: "other-value" })).toBe("a-key-value")
  expect(localAPIKey({ DIPARNUX_API_KEY: "   ", LLAMA_API_KEY: "other-value" })).toBe("other-value")
  expect(localAPIKey({})).toBeUndefined()
})

test("T1.3 a Diparnux gateway is recognised and its slots are read", async () => {
  behaviour = { header: "0.5.3", info: goodInfo, propsCtx: 65536 }
  const [server] = await detect()
  expect(server!.diparnux).toEqual({ version: "0.5.3", state: "running", model: "qwen2.5-coder-7b-instruct-q4_k_m.gguf", ctxPerSlot: 16384, slots: 2 })
  const model = Object.values(server!.models)[0]!
  expect(model.details).toBe("Diparnux 0.5.3 · 2 slots")
  // T1.6: the props window (65536) and the slot window (16384) disagree: the smaller one is used
  expect(model.context).toBe(16384)
  expect(model.maxContext).toBe(65536)
})

test("slots chosen by the server are not given a made-up number", async () => {
  behaviour = { info: { diparnux: "0.5.3", server: "running", slots_auto: true, ctx_per_slot: 8192 } }
  const [server] = await detect()
  expect(server!.diparnux).toMatchObject({ slotsAuto: true })
  expect(server!.diparnux!.slots).toBeUndefined()
  expect(Object.values(server!.models)[0]!.details).toBe("Diparnux 0.5.3 · slots chosen by the server")
})

test("T1.4 a plain llama.cpp is detected exactly as before", async () => {
  behaviour = { propsCtx: 8192 }
  const [server] = await detect()
  expect(server!.diparnux).toBeUndefined()
  const model = Object.values(server!.models)[0]!
  expect(model.details).toBeUndefined()
  expect(model.context).toBe(8192)
  expect(server!.baseURL).toBe(`${base}/v1`)
})

test("T1.5 hostile /diparnux/info values are ignored field by field", () => {
  const info = parseDiparnuxInfo({
    diparnux: "0.5.3\u001b[31m",
    server: "run\u0007ning",
    model: "x".repeat(500),
    ctx_per_slot: 1e12,
    slots: "3",
  })!
  expect(info.version).toBe("0.5.3[31m")
  expect(info.state).toBe("running")
  expect(info.model).toHaveLength(200)
  expect(info.ctxPerSlot).toBeUndefined()
  expect(info.slots).toBeUndefined()
  expect(parseDiparnuxInfo({ diparnux: "1", slots: -1, ctx_per_slot: 0.5 })).toEqual({ version: "1" })
  expect(parseDiparnuxInfo({ diparnux: "1", slots: 2, slots_auto: true })).toMatchObject({ slotsAuto: true })
  // not Diparnux: no name, wrong type, wrong shape
  expect(parseDiparnuxInfo({ slots: 2 })).toBeUndefined()
  expect(parseDiparnuxInfo({ diparnux: 5 })).toBeUndefined()
  expect(parseDiparnuxInfo([1, 2])).toBeUndefined()
  expect(parseDiparnuxInfo("diparnux")).toBeUndefined()
  // the header alone is enough to say what it is
  expect(parseDiparnuxInfo(undefined, "0.5.4")).toEqual({ version: "0.5.4" })
})

test("T1.7/T1.8 a configured provider gets its window from the gateway, unless the config says one", async () => {
  behaviour = { info: goodInfo }
  useProject(tmpDir(), {
    provider: {
      dip: { name: "Diparnux", api: `${base}/v1`, models: { guess: { name: "Guess" }, pinned: { name: "Pinned", limit: { context: 5000 } } } },
    },
  })
  const dip = (await allProviders()).dip!
  expect(dip.diparnux).toMatchObject({ version: "0.5.3", slots: 2 })
  expect(dip.models.guess!.limit.context).toBe(16384)
  expect(dip.models.pinned!.limit.context).toBe(5000)
})

test("a configured provider that lists no models gets them, with the slot window", async () => {
  behaviour = { info: goodInfo }
  useProject(tmpDir(), { provider: { dip: { name: "Diparnux", api: `${base}/v1` } } })
  const dip = (await allProviders()).dip!
  const models = Object.values(dip.models)
  expect(models.length).toBe(1)
  expect(models[0]!.limit.context).toBe(16384)
})

test("T1.9 a hosted address is never asked for /diparnux/info", async () => {
  const requested: string[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: any, init?: any) => {
    requested.push(typeof input === "string" ? input : (input.url ?? String(input)))
    return new Response("not found", { status: 404 })
  }) as typeof fetch
  try {
    useProject(tmpDir(), { provider: { hosted: { name: "Hosted", api: "https://api.example.test/v1", options: { apiKey: "sk-test-not-a-real-key-hosted-000" }, models: { m: { name: "M" } } } } })
    const providers = await allProviders()
    expect(providers.hosted!.local).toBe(false)
  } finally {
    globalThis.fetch = realFetch
  }
  expect(requested.filter((u) => u.includes("/diparnux/info"))).toEqual([])
  expect(requested.filter((u) => u.includes("api.example.test"))).toEqual([])
})

test("T1.10 a redirect is an error and the key never reaches the second host", async () => {
  const second: string[] = []
  const other = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      second.push(req.headers.get("authorization") ?? "(none)")
      return json({ default_generation_settings: { n_ctx: 1 } })
    },
  })
  try {
    behaviour = { redirectProps: `http://127.0.0.1:${other.port}/props` }
    process.env.DIPARNUX_API_KEY = KEY
    expect(await detect()).toEqual([])
    expect(second).toEqual([])
  } finally {
    other.stop(true)
  }
})

test("a detected gateway gets the key from the environment as its credential", async () => {
  behaviour = { needKey: KEY, info: goodInfo }
  process.env.DIPARNUX_API_KEY = KEY
  setDefaultEndpoints({ llamacpp: base, ollama: dead, lmstudio: dead, vllm: dead })
  useProject(tmpDir(), {})
  const llama = (await allProviders()).llamacpp!
  expect(llama.apiKey).toBe(KEY)
  expect(llama.source).toBe("env")
  expect(llama.env).toEqual(["DIPARNUX_API_KEY", "LLAMA_API_KEY"])
  expect(llama.diparnux?.slots).toBe(2)

  delete process.env.DIPARNUX_API_KEY
  useProject(tmpDir(), {})
  behaviour = { info: goodInfo }
  const open = (await allProviders()).llamacpp!
  expect(open.apiKey).toBeUndefined()
  expect(open.source).toBe("local")
})

test("T1.11 the key never appears in what debug prints or in redacted text", async () => {
  behaviour = { needKey: KEY, info: goodInfo, chat: () => json({ choices: [{ message: { tool_calls: [{ function: { name: "get_time", arguments: '{"city":"Seoul"}' } }] } }] }) }
  process.env.DIPARNUX_API_KEY = KEY
  const lines: string[] = []
  await runLocalDebug({ endpoints: { llamacpp: base, ollama: dead, lmstudio: dead, vllm: dead }, checkTools: true, out: (l = "") => void lines.push(l), timeoutMs: 1500 })
  expect(lines.join("\n")).not.toContain(KEY)
  expect(redact(`error talking to ${base} with ${KEY}`)).not.toContain(KEY)
})

// ---- VE4 ----------------------------------------------------------------------------------

const toolCall = () => json({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "get_time", arguments: '{"city":"Seoul"}' } }] } }] })
const text = (content: string) => json({ choices: [{ message: { role: "assistant", content } }] })

test("T4.1 structured tool calls are ok", async () => {
  behaviour = { chat: toolCall }
  const r = await checkToolCalling({ baseURL: `${base}/v1`, model: "m" })
  expect(r.status).toBe("ok")
})

test("T4.2 a tool call written as text is recovered, and reported as such", async () => {
  behaviour = { chat: () => text('Sure.\n<tool_call>\n{"name": "get_time", "arguments": {"city": "Seoul"}}\n</tool_call>') }
  expect((await checkToolCalling({ baseURL: `${base}/v1`, model: "m" })).status).toBe("recovered")
})

test("T4.3 an answer in prose is a failure with a reason", async () => {
  behaviour = { chat: () => text("It is probably afternoon in Seoul.") }
  const r = await checkToolCalling({ baseURL: `${base}/v1`, model: "m" })
  expect(r.status).toBe("failed")
  expect(r.detail).toContain("prose")
  behaviour = { chat: () => json({ choices: [{ message: { tool_calls: [{ function: { name: "launch", arguments: "{}" } }] } }] }) }
  expect((await checkToolCalling({ baseURL: `${base}/v1`, model: "m" })).status).toBe("failed")
  behaviour = { chat: () => json({ choices: [{ message: { tool_calls: [{ function: { name: "get_time", arguments: "[1]" } }] } }] }) }
  expect((await checkToolCalling({ baseURL: `${base}/v1`, model: "m" })).status).toBe("failed")
})

test("T4.4 401 gets the key guidance, in the check and in the report", async () => {
  behaviour = { needKey: KEY, chat: toolCall }
  expect((await checkToolCalling({ baseURL: `${base}/v1`, model: "m" })).status).toBe("unauthorized")
  expect((await checkToolCalling({ baseURL: `${base}/v1`, model: "m", apiKey: KEY })).status).toBe("ok")

  const lines: string[] = []
  await runLocalDebug({ endpoints: { llamacpp: base, ollama: dead, lmstudio: dead, vllm: dead }, out: (l = "") => void lines.push(l), timeoutMs: 1500 })
  const report = lines.join("\n")
  expect(report).toContain("answered 401: this server needs an API key")
  expect(report).toContain("DIPARNUX_API_KEY")
  expect(report).not.toContain("None found")
})

test("T4.5 without --check-tools no model request is made", async () => {
  behaviour = { info: goodInfo, chat: toolCall }
  const lines: string[] = []
  await runLocalDebug({ endpoints: { llamacpp: base, ollama: dead, lmstudio: dead, vllm: dead }, out: (l = "") => void lines.push(l), timeoutMs: 1500 })
  expect(seen.some((s) => s.path === "/v1/chat/completions")).toBe(false)
  expect(lines.join("\n")).not.toContain("tool call check")
  expect(lines.join("\n")).toContain("--check-tools")

  seen = []
  await runLocalDebug({ endpoints: { llamacpp: base, ollama: dead, lmstudio: dead, vllm: dead }, checkTools: true, out: () => {}, timeoutMs: 1500 })
  expect(seen.filter((s) => s.path === "/v1/chat/completions")).toHaveLength(1)
})

test("the report for a Diparnux gateway shows server, slots and window", async () => {
  behaviour = { header: "0.5.3", info: goodInfo, chat: toolCall }
  const lines: string[] = []
  await runLocalDebug({ endpoints: { llamacpp: base, ollama: dead, lmstudio: dead, vllm: dead }, checkTools: true, out: (l = "") => void lines.push(l), timeoutMs: 1500 })
  const report = lines.join("\n")
  expect(report).toContain("Diparnux 0.5.3 · server running · 2 slots · 16,384 ctx per slot")
  expect(report).toContain("tool call check: ok (structured tool_calls")
  expect(report).toContain("16,384 ctx")
})

test("T4.6 automatic slots print their guidance and no invented number", async () => {
  behaviour = { info: { diparnux: "0.5.3", server: "running", slots_auto: true, ctx_per_slot: 8192 } }
  const lines: string[] = []
  await runLocalDebug({ endpoints: { llamacpp: base, ollama: dead, lmstudio: dead, vllm: dead }, out: (l = "") => void lines.push(l), timeoutMs: 1500 })
  const report = lines.join("\n")
  expect(report).toContain("slots chosen by the server")
  expect(report).toContain("set options.max_concurrency if you see 429")
  expect(report).not.toMatch(/\d+ slots?/)
})

test("a server that is not running is flagged", async () => {
  behaviour = { info: { diparnux: "0.5.3", server: "stopped" } }
  const lines: string[] = []
  await runLocalDebug({ endpoints: { llamacpp: base, ollama: dead, lmstudio: dead, vllm: dead }, out: (l = "") => void lines.push(l), timeoutMs: 1500 })
  expect(lines.join("\n")).toContain("the server is stopped; start it with: diparnux serve start")
})

test("T4.7 a real llama.cpp prints no Diparnux or slot lines", async () => {
  behaviour = { propsCtx: 4096 }
  const lines: string[] = []
  await runLocalDebug({ endpoints: { llamacpp: base, ollama: dead, lmstudio: dead, vllm: dead }, out: (l = "") => void lines.push(l), timeoutMs: 1500 })
  const report = lines.join("\n")
  expect(report).not.toContain("Diparnux")
  expect(report).not.toContain("slot")
  expect(report).toContain(`llama.cpp  ${base}/v1  (openai protocol)`)
  expect(report).toContain("context under 8K tokens")
})

test("nothing found prints the start-up hints", async () => {
  const lines: string[] = []
  await runLocalDebug({ endpoints: { llamacpp: dead, ollama: dead, lmstudio: dead, vllm: dead }, out: (l = "") => void lines.push(l), timeoutMs: 500 })
  expect(lines.join("\n")).toContain("None found. Start one")
})
