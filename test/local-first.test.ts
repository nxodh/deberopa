import { afterAll, beforeAll, expect, test } from "bun:test"
import { startServer } from "../src/server/server"
import { generationSpeed, modelMode, describeMode, probeSlots, checkOllamaToolCalling, startHint, validPullName, pullOllamaModel } from "../src/provider/localmode"
import { prompt } from "../src/session/prompt"
import { createSession, getMessages } from "../src/session/store"
import { allProviders } from "../src/provider/provider"
import { endProject, mockConfig, reply, startMockLLM, tmpDir, useProject, type MockLLM } from "./helpers"

// A fake Ollama: native chat, tags, show and a streaming pull.
let ollama: ReturnType<typeof Bun.serve>
let ollamaChat: (body: any) => Response = () => new Response("{}")
let ollamaPulls: any[] = []
let slots: any = [{ id: 0, n_ctx: 8192, is_processing: true }, { id: 1, n_ctx: 8192, is_processing: false }]

let mock: MockLLM
let server: ReturnType<typeof startServer>
let base: string

const call = async (method: string, route: string, body?: unknown) => {
  const res = await fetch(base + route, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } })
  const text = await res.text()
  let data: any = text
  try {
    data = JSON.parse(text)
  } catch {}
  return { status: res.status, data }
}

beforeAll(() => {
  mock = startMockLLM()
  ollama = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/api/tags") return Response.json({ models: [{ name: "qwen3:8b", model: "qwen3:8b", details: { parameter_size: "8B" } }] })
      if (url.pathname === "/api/show") return Response.json({ model_info: { "general.architecture": "qwen3", "qwen3.context_length": 32768 }, capabilities: ["completion", "tools"] })
      if (url.pathname === "/api/chat") return ollamaChat(await req.json())
      if (url.pathname === "/api/pull") {
        const body: any = await req.json()
        ollamaPulls.push(body)
        if (String(body.model).includes("missing")) return new Response(JSON.stringify({ error: "pull model manifest: file does not exist" }) + "\n")
        const lines = [{ status: "pulling manifest" }, { status: "pulling abc", digest: "sha256:abc", total: 100, completed: 40 }, { status: "pulling abc", digest: "sha256:abc", total: 100, completed: 100 }, { status: "success" }]
        return new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
      }
      if (url.pathname === "/slots") return Response.json(slots)
      return new Response("not found", { status: 404 })
    },
  })
  const dir = tmpDir()
  useProject(
    dir,
    mockConfig(mock, {
      provider: {
        mock: { name: "Mock", api: mock.url, models: { "mock-1": { name: "Mock 1", tool_call: true, limit: { context: 100000, output: 4000 } }, "tiny-1": { name: "Tiny", tool_call: true, limit: { context: 4096, output: 1000 } } } },
        fakeollama: { name: "Fake Ollama", protocol: "ollama", api: `http://127.0.0.1:${ollama.port}`, models: { "qwen3:8b": { name: "Qwen3 8B", tool_call: true, limit: { context: 32768, output: 4096 } } } },
      },
    }),
  )
  server = startServer({ port: 0 })
  base = `http://127.0.0.1:${server.port}`
})
afterAll(() => {
  server.stop(true)
  ollama.stop(true)
  mock.stop()
  endProject()
})

test("speed uses the server's timings, and falls back to elapsed time", () => {
  expect(generationSpeed({ tokens: { output: 100 }, timings: { generationMs: 2000 } })).toEqual({ tokensPerSecond: 50, source: "server" })
  const elapsed = generationSpeed({ tokens: { output: 60 }, time: { created: 1000, completed: 4000 } })
  expect(elapsed?.source).toBe("elapsed")
  expect(elapsed?.tokensPerSecond).toBeCloseTo(20)
  expect(generationSpeed({ tokens: { output: 0 }, timings: { generationMs: 100 } })).toBeUndefined()
  expect(generationSpeed({})).toBeUndefined()
})

test("model mode explains the compact prompt in words", async () => {
  const providers = await allProviders()
  const tiny = modelMode({ local: true }, providers.mock!.models["tiny-1"]!)
  expect(tiny.compactPrompt).toBe(true)
  expect(tiny.compactReason).toBe("small-context")
  expect(describeMode(tiny)).toContain("compact prompt")
  const big = modelMode({ local: true }, providers.mock!.models["mock-1"]!)
  expect(big.compactPrompt).toBe(false)
  expect(big.compactReason).toBe("off")
  expect(modelMode({ local: false }, providers.mock!.models["tiny-1"]!).compactReason).toBe("hosted")
})

test("the provider route carries the mode of every model", async () => {
  const data = (await call("GET", "/provider")).data
  const mockProvider = data.providers.find((p: any) => p.id === "mock")
  expect(mockProvider.models["tiny-1"].mode.compactPrompt).toBe(true)
  expect(mockProvider.models["mock-1"].mode.textToolRecovery).toBe(true)
})

test("a tool call the model wrote as text is flagged on the part, and timings reach the message", async () => {
  const session = await createSession()
  mock.queue({ chunks: [...reply.text('{"name": "glob", "arguments": {"pattern": "*.nothing"}}').chunks!.slice(0, -1), { choices: [], usage: { prompt_tokens: 10, completion_tokens: 20 }, timings: { prompt_ms: 40, predicted_ms: 500 } }] })
  mock.queue(reply.text("done"))
  await prompt({ sessionID: session.id, text: "find files" })
  const messages = await getMessages(session.id)
  const tool = messages.flatMap((m) => m.parts).find((p: any) => p.type === "tool") as any
  expect(tool?.viaText).toBe(true)
  const first = messages.find((m) => m.role === "assistant") as any
  expect(first.timings).toEqual({ promptMs: 40, generationMs: 500 })
})

test("an Ollama response carries its own timings", async () => {
  ollamaChat = () =>
    new Response(
      [
        { message: { role: "assistant", content: "hi" }, done: false },
        { message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 12, eval_count: 30, eval_duration: 1_500_000_000, prompt_eval_duration: 200_000_000 },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n") + "\n",
    )
  const session = await createSession()
  await prompt({ sessionID: session.id, text: "hello", model: { providerID: "fakeollama", modelID: "qwen3:8b" } })
  const assistant = (await getMessages(session.id)).find((m) => m.role === "assistant") as any
  expect(assistant.timings).toEqual({ promptMs: 200, generationMs: 1500 })
  expect(generationSpeed(assistant)?.tokensPerSecond).toBeCloseTo(20)
})

test("the Ollama tool check tells ok, recovered, failed and missing apart", async () => {
  const opts = { baseURL: `http://127.0.0.1:${ollama.port}`, model: "qwen3:8b" }
  ollamaChat = () => Response.json({ message: { role: "assistant", content: "", tool_calls: [{ function: { name: "get_time", arguments: { city: "Seoul" } } }] } })
  expect((await checkOllamaToolCalling(opts)).status).toBe("ok")
  ollamaChat = () => Response.json({ message: { role: "assistant", content: '<tool_call>\n{"name": "get_time", "arguments": {"city": "Seoul"}}\n</tool_call>' } })
  expect((await checkOllamaToolCalling(opts)).status).toBe("recovered")
  ollamaChat = () => Response.json({ message: { role: "assistant", content: "It is afternoon." } })
  expect((await checkOllamaToolCalling(opts)).status).toBe("failed")
  ollamaChat = () => new Response("model not found", { status: 404 })
  const missing = await checkOllamaToolCalling(opts)
  expect(missing.status).toBe("error")
  expect(missing.detail).toContain("ollama pull qwen3:8b")
  ollamaChat = () => new Response(JSON.stringify({ error: "registry.ollama.ai/library/x does not support tools" }), { status: 400 })
  expect((await checkOllamaToolCalling(opts)).status).toBe("failed")
})

test("the tool check route runs against a configured provider's model", async () => {
  ollamaChat = () => Response.json({ message: { role: "assistant", content: "", tool_calls: [{ function: { name: "get_time", arguments: { city: "Seoul" } } }] } })
  const ok = await call("POST", "/local/toolcheck", { model: "fakeollama/qwen3:8b" })
  expect(ok.status).toBe(200)
  expect(ok.data.status).toBe("ok")
  expect((await call("POST", "/local/toolcheck", { model: "nope" })).status).toBe(400)
  expect((await call("POST", "/local/toolcheck", { model: "ghost/model" })).data.status).toBe("error")
})

test("slot usage is read from /slots, and absent when the server does not offer it", async () => {
  const root = `http://127.0.0.1:${ollama.port}`
  expect(await probeSlots(root)).toEqual({ total: 2, busy: 1, ctxPerSlot: 8192 })
  expect(await probeSlots(`${root}/v1`)).toEqual({ total: 2, busy: 1, ctxPerSlot: 8192 })
  const viaRoute = await call("GET", "/local/slots?provider=fakeollama")
  expect(viaRoute.data.slots).toEqual({ total: 2, busy: 1, ctxPerSlot: 8192 })
  expect((await call("GET", "/local/slots?provider=ghost")).status).toBe(404)
  slots = { error: "not enabled" }
  expect(await probeSlots(root)).toBeUndefined()
})

test("start hints name the right command for each server", () => {
  expect(startHint("opereta")).toContain("opereta serve start")
  expect(startHint("llamacpp")).toContain("--jinja")
  expect(startHint("ollama", "darwin")).toContain("Ollama app")
  expect(startHint("ollama", "linux")).toContain("ollama serve")
})

test("a model pull reports progress on the event stream and refuses bad names and hosted providers", async () => {
  expect(validPullName("qwen3:8b")).toBe(true)
  expect(validPullName("hf.co/user/model:Q4_K_M")).toBe(true)
  expect(validPullName("a b")).toBe(false)
  expect(validPullName("../x")).toBe(false)
  expect((await call("POST", "/local/pull", { provider: "fakeollama", model: "a b" })).status).toBe(400)
  expect((await call("POST", "/local/pull", { provider: "mock", model: "qwen3:8b" })).status).toBe(404)

  const controller = new AbortController()
  const events: any[] = []
  const stream = await fetch(base + "/event", { signal: controller.signal })
  const reader = stream.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        buffer += decoder.decode(value)
        for (const block of buffer.split("\n\n").slice(0, -1)) {
          const data = block.split("\n").find((l) => l.startsWith("data:"))
          if (data) events.push(JSON.parse(data.slice(5)))
        }
        buffer = buffer.slice(buffer.lastIndexOf("\n\n") + 2)
      }
    } catch {}
  })()
  const end = Date.now() + 5000
  while (!events.some((e) => e.type === "server.connected") && Date.now() < end) await new Promise((r) => setTimeout(r, 20))
  const accepted = await call("POST", "/local/pull", { provider: "fakeollama", model: "qwen3:14b" })
  expect(accepted.status).toBe(202)
  while (!events.some((e) => e.type === "local.pull" && e.properties.done) && Date.now() < end) await new Promise((r) => setTimeout(r, 20))
  controller.abort()
  await pump
  const pulls = events.filter((e) => e.type === "local.pull").map((e) => e.properties)
  expect(pulls.some((p) => p.completed === 40 && p.total === 100)).toBe(true)
  expect(pulls.at(-1)).toMatchObject({ model: "qwen3:14b", status: "success", done: true })
  expect(ollamaPulls.at(-1)).toMatchObject({ model: "qwen3:14b", stream: true })
})

test("a pull the registry refuses surfaces its error", async () => {
  await expect(pullOllamaModel("fakeollama", "missing:1b", () => {})).rejects.toThrow(/does not exist/)
})

// CLI: `deberopa local ...` against the same fake servers, through the real entry point.
const cli = async (args: string[]) => {
  const config = {
    model: "fakeollama/qwen3:8b",
    snapshot: false,
    provider: { fakeollama: { name: "Fake Ollama", protocol: "ollama", api: `http://127.0.0.1:${ollama.port}`, models: { "qwen3:8b": { name: "Qwen3 8B", tool_call: true, limit: { context: 32768, output: 4096 } } } } },
  }
  const proc = Bun.spawn([process.execPath, "run", "src/index.ts", "local", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, DEBEROPA_CONFIG_CONTENT: JSON.stringify(config), DEBEROPA_DISABLE_LOCAL_DETECT: "1", DEBEROPA_DISABLE_MODELS_FETCH: "1" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code: await proc.exited, stdout, stderr }
}

test("deberopa local: servers, check, pull and status", async () => {
  const servers = await cli([])
  expect(servers.code).toBe(0)
  expect(servers.stdout).toContain("No local model server answered")
  expect(servers.stdout).toContain("ollama serve")

  ollamaChat = () => Response.json({ message: { role: "assistant", content: "", tool_calls: [{ function: { name: "get_time", arguments: { city: "Seoul" } } }] } })
  const check = await cli(["check"])
  expect(check.code).toBe(0)
  expect(check.stdout).toContain("Tool calls work")
  ollamaChat = () => Response.json({ message: { role: "assistant", content: "It is afternoon." } })
  const failed = await cli(["check", "fakeollama/qwen3:8b"])
  expect(failed.code).toBe(1)
  expect(failed.stdout).toContain("Tool calls do not work")

  const pulled = await cli(["pull", "qwen3:14b"])
  expect(pulled.code).toBe(0)
  expect(pulled.stdout).toContain("pulling abc 40%")
  expect(pulled.stdout).toContain("qwen3:14b is ready")
  expect((await cli(["pull", "bad name"])).code).not.toBe(0)

  const status = await cli(["status"])
  expect(status.code).toBe(0)
  expect(status.stdout).toContain("Qwen3 8B")
  expect(status.stdout).toContain("context window 32,768 tokens")
  expect((await cli(["bogus"])).code).not.toBe(0)
}, 60_000)
