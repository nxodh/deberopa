import { VERSION } from "../global"
import { redact } from "../util/redact"
import { SMALL_CONTEXT, SMALL_MODEL_B, useCompactPrompt } from "../session/system"
import { parseTextToolCalls } from "./compat"
import { checkToolCalling, type ToolCheckResult } from "./toolcheck"
import { describeTlsError, hostOf, tlsInit } from "./tls"
import { allProviders, resetProviders } from "./provider"
import { isLocalURL, probe } from "./local"
import type { Model, ProviderInfo, Timings } from "./types"

/** How Deberopa adapts its requests to a model, in words a user can act on. */
export interface ModelMode {
  /** Short system prompt and fewer tools. */
  compactPrompt: boolean
  compactReason: "config" | "small-context" | "small-model" | "off" | "hosted"
  /** Tool calls the model writes as text are recovered and run. Always on when tools are offered. */
  textToolRecovery: boolean
  /** The model advertises structured tool calls. */
  structuredTools: boolean
  contextWindow: number
}

export function modelMode(provider: Pick<ProviderInfo, "local">, model: Model): ModelMode {
  const compactPrompt = useCompactPrompt(provider, model)
  const explicit = (model.options as Record<string, unknown> | undefined)?.compact_prompt
  let compactReason: ModelMode["compactReason"]
  if (typeof explicit === "boolean") compactReason = "config"
  else if (!provider.local) compactReason = "hosted"
  else if (!compactPrompt) compactReason = "off"
  else if (model.limit.context > 0 && model.limit.context <= SMALL_CONTEXT) compactReason = "small-context"
  else compactReason = "small-model"
  return { compactPrompt, compactReason, textToolRecovery: true, structuredTools: model.toolCall !== false, contextWindow: model.limit.context }
}

/** One sentence for the mode, for status lines and tooltips. */
export function describeMode(mode: ModelMode): string {
  const parts: string[] = []
  if (mode.compactPrompt) {
    const why =
      mode.compactReason === "small-context"
        ? `context of ${mode.contextWindow.toLocaleString("en-US")} tokens or less`
        : mode.compactReason === "small-model"
          ? `model of ${SMALL_MODEL_B}B parameters or fewer`
          : "set in config"
    parts.push(`compact prompt (${why})`)
  } else parts.push("full prompt")
  parts.push(mode.structuredTools ? "structured tool calls, text calls recovered" : "tool calls read from text")
  return parts.join(" · ")
}

/** Tokens per second for one response, from the server's own timings when it gave them. */
export function generationSpeed(message: { tokens?: { output: number }; timings?: Timings; time?: { created: number; completed?: number } }): { tokensPerSecond: number; source: "server" | "elapsed" } | undefined {
  const output = message.tokens?.output ?? 0
  if (output <= 0) return undefined
  const ms = message.timings?.generationMs
  if (ms && ms > 0) return { tokensPerSecond: output / (ms / 1000), source: "server" }
  const created = message.time?.created
  const completed = message.time?.completed
  if (created && completed && completed > created) return { tokensPerSecond: output / ((completed - created) / 1000), source: "elapsed" }
  return undefined
}

export interface SlotUsage {
  total: number
  busy: number
  ctxPerSlot?: number
}

/** llama-server's /slots (needs the server's slots endpoint enabled). Undefined when it is off or not llama.cpp. */
export async function probeSlots(baseURL: string, apiKey?: string, timeoutMs = 1500): Promise<SlotUsage | undefined> {
  const root = baseURL.replace(/\/+$/, "").replace(/\/v1$/, "")
  const result = await probe(`${root}/slots`, timeoutMs, apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}, { jsonOnly: true })
  if (!result.ok || !Array.isArray(result.json)) return undefined
  const slots = result.json as any[]
  const ctx = Number(slots[0]?.n_ctx)
  return { total: slots.length, busy: slots.filter((s) => s?.is_processing === true || s?.state === 1).length, ...(Number.isFinite(ctx) && ctx > 0 ? { ctxPerSlot: ctx } : {}) }
}

const TOOL = "get_time"

/** The same question as the OpenAI-style check, asked through Ollama's native chat API. */
export async function checkOllamaToolCalling(opts: { baseURL: string; model: string; tls?: ProviderInfo["tls"]; providerID?: string; timeoutMs?: number }): Promise<ToolCheckResult> {
  const started = Date.now()
  const done = (status: ToolCheckResult["status"], detail?: string): ToolCheckResult => ({ status, ms: Date.now() - started, detail })
  let response: Response
  try {
    response = await fetch(`${opts.baseURL.replace(/\/+$/, "")}/api/chat`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 180_000),
      headers: { "Content-Type": "application/json", "User-Agent": `deberopa/${VERSION}` },
      body: JSON.stringify({
        model: opts.model,
        stream: false,
        messages: [{ role: "user", content: "What time is it in Seoul right now? Use the get_time tool." }],
        tools: [{ type: "function", function: { name: TOOL, description: "Get the current time in a city.", parameters: { type: "object", properties: { city: { type: "string", description: "City name" } }, required: ["city"] } } }],
        options: { temperature: 0, num_predict: 128 },
      }),
      ...tlsInit(opts.tls),
    } as RequestInit)
  } catch (err) {
    const advice = describeTlsError(err, { providerID: opts.providerID ?? "ollama", host: hostOf(opts.baseURL), hasCA: !!opts.tls })
    return done("error", redact(advice ?? (err instanceof Error ? err.message : String(err))))
  }
  const text = await response.text()
  if (response.status === 404) return done("error", `Ollama has no model "${opts.model}". Download it with: ollama pull ${opts.model}`)
  if (response.status === 400 && /does not support tools/i.test(text)) return done("failed", "this model's template has no tool support")
  if (!response.ok) return done("error", redact(`HTTP ${response.status}: ${text.slice(0, 200)}`))
  let body: any
  try {
    body = JSON.parse(text)
  } catch {
    return done("error", "the server did not answer with JSON")
  }
  const calls = body?.message?.tool_calls
  if (Array.isArray(calls) && calls.some((c: any) => c?.function?.name === TOOL)) return done("ok")
  const content = typeof body?.message?.content === "string" ? body.message.content : ""
  if (parseTextToolCalls(content, [TOOL])) return done("recovered")
  return done("failed", "the answer contained no tool call")
}

/** Run the tool-call check against a configured provider's model. */
export async function toolCheckModel(providerID: string, modelID: string): Promise<ToolCheckResult> {
  const provider = (await allProviders())[providerID]
  if (!provider) return { status: "error", ms: 0, detail: `Unknown provider: ${providerID}` }
  const model = provider.models[modelID]
  if (!model) return { status: "error", ms: 0, detail: `${providerID} has no model ${modelID}` }
  if (!provider.baseURL) return { status: "error", ms: 0, detail: "the provider has no address" }
  if (provider.protocol === "anthropic") return { status: "error", ms: 0, detail: "hosted Anthropic models are not checked" }
  if (provider.protocol === "ollama") return checkOllamaToolCalling({ baseURL: provider.baseURL, model: model.id, tls: provider.tls, providerID })
  return checkToolCalling({ baseURL: provider.baseURL, model: model.id, apiKey: provider.apiKey, headers: provider.headers, tls: provider.tls, providerID })
}

/** What to run when a local server is not answering. The wording follows the server kind. */
export function startHint(kind: "ollama" | "lmstudio" | "llamacpp" | "vllm" | "opereta", platform: NodeJS.Platform = process.platform): string {
  switch (kind) {
    case "opereta":
      return "Start it with: opereta serve start"
    case "ollama":
      return platform === "linux" ? "Start it with: ollama serve  (or: systemctl start ollama)" : "Start the Ollama app, or run: ollama serve"
    case "lmstudio":
      return "Open LM Studio and start the local server (Developer tab), or run: lms server start"
    case "llamacpp":
      return "Start it with: llama-server -m <model.gguf> --jinja   (--jinja is needed for tool calls)"
    case "vllm":
      return "Start it with: vllm serve <model> --enable-auto-tool-choice --tool-call-parser <parser>"
  }
}

/** Where each kind is expected, for "nothing found" messages. */
export const DEFAULT_PORTS: { kind: "ollama" | "lmstudio" | "llamacpp" | "vllm"; name: string; port: number }[] = [
  { kind: "ollama", name: "Ollama", port: 11434 },
  { kind: "lmstudio", name: "LM Studio", port: 1234 },
  { kind: "llamacpp", name: "llama.cpp / Opereta", port: 8080 },
  { kind: "vllm", name: "vLLM", port: 8000 },
]

export interface PullProgress {
  model: string
  status: string
  completed?: number
  total?: number
  done: boolean
  error?: string
}

const PULL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/

export function validPullName(name: unknown): name is string {
  return typeof name === "string" && PULL_NAME.test(name)
}

/**
 * `ollama pull` through the API, reporting progress. Only for an Ollama-protocol provider on this machine
 * or its network, so a pull request never reaches a hosted service with a local key.
 */
export async function pullOllamaModel(providerID: string, model: string, onProgress: (p: PullProgress) => void, signal?: AbortSignal): Promise<void> {
  if (!validPullName(model)) throw new Error("That is not a valid model name.")
  const provider = (await allProviders())[providerID]
  if (!provider || provider.protocol !== "ollama" || !provider.baseURL) throw new Error(`${providerID} is not an Ollama server.`)
  if (!isLocalURL(provider.baseURL)) throw new Error("Models are only pulled to an Ollama server on this machine or its network.")
  const response = await fetch(`${provider.baseURL.replace(/\/+$/, "")}/api/pull`, {
    method: "POST",
    redirect: "error",
    signal,
    headers: { "Content-Type": "application/json", "User-Agent": `deberopa/${VERSION}` },
    body: JSON.stringify({ model, stream: true }),
    ...tlsInit(provider.tls),
  } as RequestInit)
  if (!response.ok || !response.body) throw new Error(redact(`Ollama answered HTTP ${response.status}: ${(await response.text().catch(() => "")).slice(0, 200)}`))
  const decoder = new TextDecoder()
  const reader = response.body.getReader()
  let buffer = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index: number
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      let item: any
      try {
        item = JSON.parse(line)
      } catch {
        continue
      }
      if (typeof item.error === "string") throw new Error(redact(item.error))
      onProgress({ model, status: String(item.status ?? ""), completed: typeof item.completed === "number" ? item.completed : undefined, total: typeof item.total === "number" ? item.total : undefined, done: item.status === "success" })
    }
  }
  resetProviders()
}
