import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import { createLimiter, limiterFor, resetLimiters } from "../src/provider/limiter"
import { generateText, streamModel } from "../src/provider/stream"
import { allProviders } from "../src/provider/provider"
import { prompt } from "../src/session/prompt"
import { createSession } from "../src/session/store"
import { messageText } from "../src/session/message"
import type { Model, ProviderInfo, StreamEvent } from "../src/provider/types"
import { endProject, reply, startMockLLM, tmpDir, useProject, type MockLLM } from "./helpers"

// ---- a model server that counts how many requests it is serving at once -------------------

let server: ReturnType<typeof Bun.serve>
let base: string
let inflight = 0
let maxSeen = 0
let order: string[] = []
let delayMs = 60
let behaviour: "ok" | "429" | "500" = "ok"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const sse = (text: string) =>
  [
    { choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
  ]
    .map((e) => `data: ${JSON.stringify(e)}\n\n`)
    .join("") + "data: [DONE]\n\n"

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 30,
    async fetch(req) {
      const body: any = await req.json().catch(() => ({}))
      const label = String(body.messages?.at(-1)?.content ?? "")
      order.push(label)
      inflight++
      maxSeen = Math.max(maxSeen, inflight)
      try {
        await sleep(delayMs)
        if (behaviour === "429") return new Response(JSON.stringify({ error: { message: "busy" } }), { status: 429, headers: { "retry-after": "1" } })
        if (behaviour === "500") return new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 })
        return new Response(sse(`done ${label}`), { headers: { "content-type": "text/event-stream" } })
      } finally {
        inflight--
      }
    },
  })
  base = `http://127.0.0.1:${server.port}`
})
afterAll(() => {
  server.stop(true)
  endProject()
})
beforeEach(() => {
  inflight = 0
  maxSeen = 0
  order = []
  delayMs = 60
  behaviour = "ok"
  resetLimiters()
})
afterEach(() => resetLimiters())

const model: Model = {
  id: "m",
  providerID: "mock",
  name: "M",
  limit: { context: 100000, output: 4000 },
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  reasoning: false,
  toolCall: true,
  attachment: false,
  temperature: true,
}
const provider = (max?: number): ProviderInfo => ({
  id: "mock",
  name: "Mock",
  protocol: "openai",
  baseURL: `${base}/v1`,
  env: [],
  source: "config",
  models: {},
  maxConcurrency: max,
})
const key = () => `mock@${base}/v1`

async function request(label: string, opts: { max?: number; signal?: AbortSignal; priority?: "normal" | "low" } = {}) {
  const events: StreamEvent[] = []
  for await (const e of streamModel({
    provider: provider(opts.max),
    model,
    system: [],
    messages: [{ role: "user", content: [{ type: "text", text: label }] }],
    tools: [],
    signal: opts.signal,
    priority: opts.priority,
  })) {
    events.push(e)
  }
  return events
}
const text = (events: StreamEvent[]) => events.filter((e) => e.type === "text-delta").map((e: any) => e.text).join("")

// ---- the limiter itself --------------------------------------------------------------------

test("a limiter hands out at most `max` slots and passes them on in order", async () => {
  const limiter = createLimiter(2)
  const a = await limiter.acquire()
  const b = await limiter.acquire()
  expect(limiter.stats()).toEqual({ active: 2, waiting: 0 })
  const got: string[] = []
  const c = limiter.acquire().then((r) => (got.push("c"), r))
  const d = limiter.acquire().then((r) => (got.push("d"), r))
  await sleep(10)
  expect(got).toEqual([])
  expect(limiter.stats()).toEqual({ active: 2, waiting: 2 })
  a()
  await sleep(10)
  expect(got).toEqual(["c"])
  b()
  await sleep(10)
  expect(got).toEqual(["c", "d"])
  ;(await c)()
  ;(await d)()
  expect(limiter.stats()).toEqual({ active: 0, waiting: 0 })
})

test("releasing twice frees one slot, not two", async () => {
  const limiter = createLimiter(1)
  const release = await limiter.acquire()
  release()
  release()
  const next = await limiter.acquire()
  let blocked = true
  void limiter.acquire().then(() => (blocked = false))
  await sleep(10)
  expect(blocked).toBe(true) // the second release did not hand out a phantom slot
  next()
})

test("T3.5 normal requests are served before low ones", async () => {
  const limiter = createLimiter(1)
  const hold = await limiter.acquire()
  const served: string[] = []
  const low = limiter.acquire(undefined, "low").then((r) => (served.push("low"), r))
  const normal = limiter.acquire(undefined, "normal").then((r) => (served.push("normal"), r))
  hold()
  ;(await normal)()
  ;(await low)()
  expect(served).toEqual(["normal", "low"])
})

test("T3.2 a waiter that aborts leaves the queue and holds nothing", async () => {
  const limiter = createLimiter(1)
  const hold = await limiter.acquire()
  const controller = new AbortController()
  const waiting = limiter.acquire(controller.signal)
  const survivor = limiter.acquire()
  controller.abort()
  const err = await waiting.catch((e) => e)
  expect(err.name).toBe("AbortError")
  expect(limiter.stats()).toEqual({ active: 1, waiting: 1 })
  hold()
  ;(await survivor)()
  expect(limiter.stats()).toEqual({ active: 0, waiting: 0 })
  // an already-aborted signal never queues at all
  await expect(limiter.acquire(controller.signal)).rejects.toThrow("Aborted")
  expect(limiter.stats()).toEqual({ active: 0, waiting: 0 })
})

// ---- streamModel with a limit ----------------------------------------------------------------

test("T3.1 five requests with max 2 never run more than two at once", async () => {
  const results = await Promise.all(["a", "b", "c", "d", "e"].map((l) => request(l, { max: 2 })))
  expect(maxSeen).toBe(2)
  expect(results.map(text).sort()).toEqual(["done a", "done b", "done c", "done d", "done e"])
  expect(limiterFor(key(), 2).stats()).toEqual({ active: 0, waiting: 0 })
})

test("without a limit requests run together, as before", async () => {
  await Promise.all(["a", "b", "c", "d"].map((l) => request(l)))
  expect(maxSeen).toBe(4)
})

test("T3.2 aborting a queued request frees the queue for the next one", async () => {
  delayMs = 150
  const holder = request("holder", { max: 1 })
  await sleep(30)
  const controller = new AbortController()
  const queued = request("queued", { max: 1, signal: controller.signal }).catch((e) => e)
  const next = request("next", { max: 1 })
  await sleep(20)
  controller.abort()
  expect((await queued).name).toBe("AbortError")
  await holder
  expect(text(await next)).toBe("done next")
  expect(order).toEqual(["holder", "next"]) // the aborted request never reached the server
  expect(limiterFor(key(), 1).stats()).toEqual({ active: 0, waiting: 0 })
})

test("T3.3 a consumer that stops early, or a failed request, still releases the slot", async () => {
  const stream = streamModel({
    provider: provider(1),
    model,
    system: [],
    messages: [{ role: "user", content: [{ type: "text", text: "early" }] }],
    tools: [],
  })
  await stream.next() // acquire and start
  expect(limiterFor(key(), 1).stats().active).toBe(1)
  await stream.return(undefined as never)
  expect(limiterFor(key(), 1).stats().active).toBe(0)

  behaviour = "500"
  const err = await request("fails", { max: 1 }).catch((e) => e)
  expect(err.message).toContain("boom")
  expect(limiterFor(key(), 1).stats()).toEqual({ active: 0, waiting: 0 })
  behaviour = "ok"
  expect(text(await request("after", { max: 1 }))).toBe("done after")
})

test("T3.10 a 429 frees its slot at once, so others are not blocked behind the retry delay", async () => {
  behaviour = "429"
  delayMs = 20
  const err = await request("busy", { max: 1 }).catch((e) => e)
  expect(err.status).toBe(429)
  expect(err.retryAfterMs).toBe(1000)
  expect(limiterFor(key(), 1).stats().active).toBe(0)
})

test("titles and summaries yield to real work through generateText", async () => {
  delayMs = 120
  const holder = request("holder", { max: 1 })
  await sleep(30)
  const title = generateText({
    provider: provider(1),
    model,
    system: [],
    messages: [{ role: "user", content: [{ type: "text", text: "title" }] }],
  })
  const work = request("work", { max: 1 })
  await Promise.all([holder, title, work])
  expect(order).toEqual(["holder", "work", "title"])
})

// ---- settings and automatic values -------------------------------------------------------------

let gateway: ReturnType<typeof Bun.serve>
let gatewayInfo: unknown = { diparnux: "0.5.3", server: "running", slots: 3, ctx_per_slot: 8192 }

beforeAll(() => {
  gateway = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => (new URL(req.url).pathname === "/diparnux/info" ? Response.json(gatewayInfo) : new Response("nope", { status: 404 })),
  })
})
afterAll(() => gateway.stop(true))

async function providersFor(options: Record<string, unknown> | undefined, api = `http://127.0.0.1:${gateway.port}/v1`) {
  delete process.env.VEDECAPS_DISABLE_LOCAL_DETECT
  try {
    useProject(tmpDir(), { provider: { gw: { name: "GW", api, ...(options ? { options } : {}), models: { m: { name: "M" } } } } })
    return (await allProviders()).gw!
  } finally {
    process.env.VEDECAPS_DISABLE_LOCAL_DETECT = "1"
  }
}

test("T3.6 unusable values are ignored with a recorded reason", async () => {
  for (const bad of [0, -1, 1.5, "2", "abc", 65, true, [2], { n: 2 }]) {
    gatewayInfo = { diparnux: "0.5.3", server: "running", slots: 3 }
    const p = await providersFor({ max_concurrency: bad })
    expect(p.maxConcurrency, String(bad)).toBeUndefined()
    expect(p.maxConcurrencyIgnored, String(bad)).toContain("whole number from 1 to 64")
  }
})

test("an explicit null means \"not set\" and leaves the automatic value alone", async () => {
  gatewayInfo = { diparnux: "0.5.3", server: "running", slots: 3 }
  const p = await providersFor({ max_concurrency: null })
  expect(p.maxConcurrency).toBe(3)
  expect(p.maxConcurrencyIgnored).toBeUndefined()
})

test("a usable value is taken as written", async () => {
  gatewayInfo = { diparnux: "0.5.3", server: "running", slots_auto: true }
  const p = await providersFor({ max_concurrency: 4 })
  expect(p.maxConcurrency).toBe(4)
  expect(p.maxConcurrencySource).toBe("config")
  expect(p.maxConcurrencyIgnored).toBeUndefined()
})

test("T3.7 a gateway's fixed slot count becomes the limit", async () => {
  gatewayInfo = { diparnux: "0.5.3", server: "running", slots: 3, ctx_per_slot: 8192 }
  const p = await providersFor(undefined)
  expect(p.maxConcurrency).toBe(3)
  expect(p.maxConcurrencySource).toBe("diparnux")
})

test("T3.8 what the user wrote beats the gateway, smaller or larger", async () => {
  gatewayInfo = { diparnux: "0.5.3", server: "running", slots: 3 }
  expect((await providersFor({ max_concurrency: 1 })).maxConcurrency).toBe(1)
  expect((await providersFor({ max_concurrency: 6 })).maxConcurrency).toBe(6)
})

test("T3.9 slots chosen by the server give no automatic limit", async () => {
  gatewayInfo = { diparnux: "0.5.3", server: "running", slots_auto: true }
  expect((await providersFor(undefined)).maxConcurrency).toBeUndefined()
})

test("an unusable value does not fall back to the gateway's slots", async () => {
  gatewayInfo = { diparnux: "0.5.3", server: "running", slots: 3 }
  const p = await providersFor({ max_concurrency: 0 })
  expect(p.maxConcurrency).toBeUndefined() // the user tried to say something; do not guess for them
})

test("no setting and no gateway: unlimited, exactly as before", async () => {
  gatewayInfo = "404"
  const p = await providersFor(undefined)
  expect(p.maxConcurrency).toBeUndefined()
  expect(p.maxConcurrencyIgnored).toBeUndefined()
})

// ---- the agent loop with a limit of one -------------------------------------------------------

let mock: MockLLM
beforeAll(() => {
  mock = startMockLLM()
})
afterAll(() => mock.stop())

test("T3.4 with max_concurrency 1 a parent that starts two subagents finishes (no deadlock)", async () => {
  mock.reset()
  const dir = tmpDir()
  useProject(dir, {
    model: "mock/mock-1",
    snapshot: false,
    provider: { mock: { name: "Mock", api: mock.url, options: { max_concurrency: 1 }, models: { "mock-1": { name: "Mock 1", tool_call: true, limit: { context: 100000, output: 4000 } } } } },
  })
  expect((await allProviders()).mock!.maxConcurrency).toBe(1)

  mock.queue(
    reply.tools([
      { name: "task", args: { description: "first", prompt: "do the first thing", subagent_type: "general" }, id: "t1" },
      { name: "task", args: { description: "second", prompt: "do the second thing", subagent_type: "general" }, id: "t2" },
    ]),
    reply.text("child one finished"),
    reply.text("child two finished"),
    reply.text("both subagents are done"),
  )
  const session = await createSession()
  const result = await Promise.race([
    prompt({ sessionID: session.id, text: "run two subagents" }),
    sleep(20_000).then(() => {
      throw new Error("deadlock: the turn did not finish")
    }),
  ])
  expect(messageText(result!)).toBe("both subagents are done")
  expect(mock.requests).toHaveLength(4)
  expect(limiterFor(`mock@${mock.url}`, 1).stats()).toEqual({ active: 0, waiting: 0 })
})

test("a 429 followed by success completes through the normal retry, with the limit on", async () => {
  mock.reset()
  useProject(tmpDir(), {
    model: "mock/mock-1",
    snapshot: false,
    provider: { mock: { name: "Mock", api: mock.url, options: { max_concurrency: 1 }, models: { "mock-1": { name: "Mock 1", tool_call: true, limit: { context: 100000, output: 4000 } } } } },
  })
  mock.queue(reply.error(429, "slots busy"), reply.text("worked on the second try"))
  const session = await createSession()
  const result = await prompt({ sessionID: session.id, text: "hello" })
  expect(messageText(result!)).toBe("worked on the second try")
  expect(limiterFor(`mock@${mock.url}`, 1).stats()).toEqual({ active: 0, waiting: 0 })
})

// ---- acceptance: four subagents against a server with two slots --------------------------------

/** An OpenAI-style server with a fixed number of slots: a request beyond them gets 429, like Diparnux's gateway. */
function slotServer(slots: number) {
  let active = 0
  const stats = { rejected: 0, accepted: 0, peak: 0 }
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 30,
    async fetch(req) {
      const body: any = await req.json().catch(() => ({}))
      if (active >= slots) {
        stats.rejected++
        return new Response(JSON.stringify({ error: { code: "too_many_requests", message: "all slots are busy" } }), { status: 429, headers: { "retry-after": "1" } })
      }
      active++
      stats.accepted++
      stats.peak = Math.max(stats.peak, active)
      try {
        await sleep(120)
        const messages: any[] = body.messages ?? []
        const first = String(messages[0]?.content ?? "")
        const lastUser = [...messages].reverse().find((m) => m.role === "user")
        const lastText = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "")
        const chunks: unknown[] = []
        const delta = (d: unknown, finish: string | null = null) => ({ choices: [{ index: 0, delta: d, finish_reason: finish }] })
        if (first.startsWith("You generate short titles")) chunks.push(delta({ content: "Four subagents" }), delta({}, "stop"))
        else if (messages.some((m) => m.role === "tool")) chunks.push(delta({ content: "all four finished" }), delta({}, "stop"))
        else if (lastText.includes("run four")) {
          chunks.push(
            ...[1, 2, 3, 4].map((n) =>
              delta({ tool_calls: [{ index: n - 1, id: `call_${n}`, type: "function", function: { name: "task", arguments: JSON.stringify({ description: `job ${n}`, prompt: `child ${n}`, subagent_type: "general" }) } }] }),
            ),
            delta({}, "tool_calls"),
          )
        } else chunks.push(delta({ content: "child ok" }), delta({}, "stop"))
        return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
      } finally {
        active--
      }
    },
  })
  return { server, stats, url: `http://127.0.0.1:${server.port}/v1` }
}

async function fourSubagents(url: string, options: Record<string, unknown>) {
  useProject(tmpDir(), {
    model: "slots/m",
    snapshot: false,
    provider: { slots: { name: "Slots", api: url, ...(Object.keys(options).length ? { options } : {}), models: { m: { name: "M", tool_call: true, limit: { context: 100000, output: 4000 } } } } },
  })
  const session = await createSession()
  return prompt({ sessionID: session.id, text: "run four jobs" })
}

test("T4.7(acceptance) max_concurrency 2 with four subagents: not one 429, and everything finishes", async () => {
  const { server, stats, url } = slotServer(2)
  try {
    const result = await fourSubagents(url, { max_concurrency: 2 })
    expect(messageText(result!)).toBe("all four finished")
    expect(stats.rejected).toBe(0)
    expect(stats.peak).toBeLessThanOrEqual(2)
    // parent step 1, four children, title, parent step 2
    expect(stats.accepted).toBe(7)
  } finally {
    server.stop(true)
  }
})

test("control: the same session without a limit does get 429s (and still finishes through retries)", async () => {
  const { server, stats, url } = slotServer(2)
  try {
    const result = await fourSubagents(url, {})
    expect(messageText(result!)).toBe("all four finished")
    expect(stats.rejected).toBeGreaterThan(0)
  } finally {
    server.stop(true)
  }
}, 40_000)
