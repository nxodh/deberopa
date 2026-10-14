import Anthropic from "@anthropic-ai/sdk"
import { VERSION } from "../global"
import { createLogger } from "../util/log"
import { EMPTY_USAGE, ProviderError, type FinishReason, type ModelMessage, type StreamEvent, type StreamInput, type Usage } from "./types"
import { describeTlsError, hostOf, tlsInit } from "./tls"

const log = createLogger("anthropic")

type ThinkingMode = "none" | "budget" | "adaptive"

/**
 * Thinking is configured differently per model generation: 3.x has none (3.7 aside), the
 * 4.0–4.5 line takes a token budget, and everything from 4.6 on is adaptive (and rejects budgets).
 */
export function thinkingMode(modelID: string): ThinkingMode {
  const id = modelID.toLowerCase()
  if (/claude-(2|instant)/.test(id) || /claude-3-(?!7)/.test(id)) return "none"
  if (/claude-3-7/.test(id)) return "budget"
  if (/claude-(sonnet|opus)-4-(0|1|5)(?!\d)/.test(id) || /claude-(sonnet|opus)-4-20\d{6}/.test(id) || /claude-haiku-4-5/.test(id)) return "budget"
  return "adaptive"
}

/** Models whose safety classifiers can decline a request; these get server-side fallbacks. */
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"])
const FALLBACK_BETA = "server-side-fallback-2026-07-01"
let fallbacksRejected = false

function isFirstParty(baseURL?: string) {
  return !baseURL || /(^|\/\/)api\.anthropic\.com/.test(baseURL)
}

function toMessages(input: StreamInput): any[] {
  const out: any[] = []
  for (const message of input.messages) {
    if (message.role === "user") {
      const content: any[] = []
      for (const part of message.content) {
        if (part.type === "text") {
          if (part.text.trim() !== "") content.push({ type: "text", text: part.text })
        } else if (part.mime === "application/pdf") {
          content.push({ type: "document", source: { type: "base64", media_type: part.mime, data: part.data } })
        } else if (part.mime.startsWith("image/")) {
          content.push({ type: "image", source: { type: "base64", media_type: part.mime, data: part.data } })
        }
      }
      if (content.length) out.push({ role: "user", content })
    } else if (message.role === "assistant") {
      const sameModel = message.raw && message.raw.providerID === input.provider.id && message.raw.modelID === input.model.id
      if (sameModel && Array.isArray(message.raw!.content) && message.raw!.content.length) {
        // Thinking blocks are only valid when replayed byte-for-byte to the model that wrote them.
        out.push({ role: "assistant", content: message.raw!.content })
        continue
      }
      const content: any[] = []
      for (const part of message.content) {
        if (part.type === "text" && part.text.trim() !== "") content.push({ type: "text", text: part.text })
        else if (part.type === "tool-call") content.push({ type: "tool_use", id: part.id, name: part.name, input: part.input ?? {} })
      }
      if (content.length) out.push({ role: "assistant", content })
    } else {
      out.push({
        role: "user",
        content: message.results.map((result) => {
          const content: any[] = [{ type: "text", text: result.output === "" ? "(no output)" : result.output }]
          for (const file of result.attachments ?? []) {
            if (file.mime.startsWith("image/")) content.push({ type: "image", source: { type: "base64", media_type: file.mime, data: file.data } })
          }
          return { type: "tool_result", tool_use_id: result.id, content, ...(result.isError ? { is_error: true } : {}) }
        }),
      })
    }
  }
  // Cache everything up to the newest turn. The final message is always a user turn here.
  const last = out[out.length - 1]
  if (last && last.role === "user" && Array.isArray(last.content) && last.content.length) {
    const content = [...last.content]
    content[content.length - 1] = { ...content[content.length - 1], cache_control: { type: "ephemeral" } }
    out[out.length - 1] = { ...last, content }
  }
  return out
}

function buildParams(input: StreamInput, withFallbacks: boolean) {
  const { model } = input
  const mode = thinkingMode(model.id)
  const firstParty = isFirstParty(input.provider.baseURL)
  const maxTokens = Math.min(input.maxOutputTokens ?? 64_000, model.limit.output || 64_000)

  const system = input.system.filter((s) => s.trim() !== "").map((text) => ({ type: "text", text }) as any)
  if (system.length) system[system.length - 1].cache_control = { type: "ephemeral" }

  const params: any = {
    model: model.id,
    max_tokens: maxTokens,
    messages: toMessages(input),
  }
  if (system.length) params.system = system
  if (input.tools.length) {
    params.tools = input.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
      // Stream large inputs (file bodies) as they are written instead of in one late burst.
      ...(firstParty ? { eager_input_streaming: true } : {}),
    }))
  }

  if (mode === "adaptive") {
    params.thinking = { type: "adaptive", display: "summarized" }
    let effort = input.effort ?? "high"
    if (effort === "xhigh" && /-4-6/.test(model.id)) effort = "high"
    params.output_config = { effort }
  } else if (mode === "budget" && model.reasoning) {
    const budget = Math.min(16_000, Math.max(1024, maxTokens - 4096))
    if (budget < maxTokens) params.thinking = { type: "enabled", budget_tokens: budget }
  } else {
    if (input.temperature !== undefined) params.temperature = input.temperature
    if (input.topP !== undefined) params.top_p = input.topP
  }

  const betas: string[] = []
  if (mode === "budget" && params.thinking && params.tools) betas.push("interleaved-thinking-2025-05-14")
  if (withFallbacks) {
    params.fallbacks = "default"
    betas.push(FALLBACK_BETA)
  }
  return { params, betas }
}

function toError(err: unknown, tls?: { providerID: string; baseURL?: string; hasCA: boolean }): Error {
  if (err instanceof Anthropic.APIUserAbortError) {
    const abort = new Error("Aborted")
    abort.name = "AbortError"
    return abort
  }
  if (err instanceof Anthropic.APIConnectionError) {
    const host = hostOf(tls?.baseURL ?? "https://api.anthropic.com")
    const advice = tls && describeTlsError(err, { providerID: tls.providerID, host, hasCA: tls.hasCA })
    if (advice) return new ProviderError(`Could not connect to ${host}: ${advice}`, { kind: "network", retryable: false })
    return new ProviderError(`Could not reach the Anthropic API: ${err.message}`, { kind: "network" })
  }
  if (err instanceof Anthropic.APIError) {
    const body = err.error as any
    const detail = body?.error?.message ?? err.message
    const retryAfter = Number((err.headers as any)?.get?.("retry-after"))
    return new ProviderError(detail, {
      status: typeof err.status === "number" ? err.status : undefined,
      kind: body?.error?.type === "overloaded_error" ? "overloaded" : undefined,
      retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
    })
  }
  return err instanceof Error ? err : new Error(String(err))
}

function mapStop(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop"
    case "tool_use":
    case "pause_turn":
      return "tool-calls"
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length"
    case "refusal":
      return "refusal"
    default:
      return "unknown"
  }
}

export async function* streamAnthropic(input: StreamInput): AsyncGenerator<StreamEvent> {
  const { provider, model } = input
  const client = new Anthropic({
    apiKey: provider.apiKey ?? "",
    baseURL: provider.baseURL,
    maxRetries: 0, // retries are handled (and surfaced to the user) by the session loop
    timeout: provider.timeout ?? 10 * 60 * 1000,
    defaultHeaders: { "User-Agent": `deberopa/${VERSION}`, ...provider.headers },
    fetch: (url, init) => fetch(url, { ...init, redirect: "error", ...tlsInit(provider.tls) }),
  })

  const wantFallbacks = FALLBACK_MODELS.has(model.id) && isFirstParty(provider.baseURL) && !fallbacksRejected
  let emitted = false

  for (const withFallbacks of wantFallbacks ? [true, false] : [false]) {
    const { params, betas } = buildParams(input, withFallbacks)
    const tools = new Map<number, { id: string; name: string; json: string }>()
    const pendingCalls: Extract<StreamEvent, { type: "tool-call" }>[] = []
    let thinkingOpen = false
    try {
      const stream = betas.length
        ? client.beta.messages.stream({ ...params, betas }, { signal: input.signal })
        : client.messages.stream(params, { signal: input.signal })

      for await (const event of stream as AsyncIterable<any>) {
        if (event.type === "content_block_start") {
          const block = event.content_block
          if (block?.type === "tool_use") {
            tools.set(event.index, { id: block.id, name: block.name, json: "" })
            emitted = true
            yield { type: "tool-input-start", id: block.id, name: block.name }
          } else if (block?.type === "thinking") thinkingOpen = true
        } else if (event.type === "content_block_delta") {
          const delta = event.delta
          if (delta?.type === "text_delta" && delta.text) {
            emitted = true
            yield { type: "text-delta", text: delta.text }
          } else if (delta?.type === "thinking_delta" && delta.thinking) {
            emitted = true
            yield { type: "reasoning-delta", text: delta.thinking }
          } else if (delta?.type === "input_json_delta") {
            const tool = tools.get(event.index)
            if (tool) tool.json += delta.partial_json ?? ""
          }
        } else if (event.type === "content_block_stop") {
          const tool = tools.get(event.index)
          if (tool) {
            let parsed: unknown = {}
            let invalid: string | undefined
            try {
              parsed = tool.json.trim() === "" ? {} : JSON.parse(tool.json)
            } catch {
              invalid = "The tool input was not valid JSON (it may have been cut off). Send the complete call again."
            }
            pendingCalls.push({ type: "tool-call", id: tool.id, name: tool.name, input: parsed, invalid })
          } else if (thinkingOpen) {
            thinkingOpen = false
            yield { type: "reasoning-end" }
          }
        }
      }

      const final: any = await (stream as any).finalMessage()
      const reason = mapStop(final.stop_reason)
      const u = final.usage ?? {}
      const usage: Usage = {
        ...EMPTY_USAGE,
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
      }

      // A call cut off by the token limit or a refusal must never run, even if its JSON happens to parse.
      const cutOff = final.stop_reason === "max_tokens" || final.stop_reason === "refusal"
      const byID = new Map(pendingCalls.map((c) => [c.id, c]))
      for (const call of pendingCalls) {
        if (cutOff && !call.invalid) call.invalid = "The response was cut off before this tool call completed. Send it again."
        yield call
      }

      // Keep the native blocks for replay; inputs we could not parse are replaced so the echo stays valid.
      const raw = (final.content ?? []).map((block: any) => {
        if (block.type !== "tool_use") return block
        const call = byID.get(block.id)
        return { ...block, input: call && !call.invalid && typeof call.input === "object" && call.input !== null ? call.input : {} }
      })

      yield {
        type: "finish",
        reason: pendingCalls.length && reason !== "refusal" && reason !== "length" ? "tool-calls" : reason,
        usage,
        raw,
        servedBy: final.model && final.model !== model.id ? final.model : undefined,
        message:
          reason === "refusal"
            ? (final.stop_details?.explanation ?? "The model declined to respond to this request.")
            : undefined,
      }
      return
    } catch (err) {
      const error = toError(err, { providerID: provider.id, baseURL: provider.baseURL, hasCA: !!provider.tls })
      // Gateways and older deployments may not know the fallback beta: drop it once and carry on.
      if (withFallbacks && !emitted && error instanceof ProviderError && error.status === 400 && /fallback|beta/i.test(error.message)) {
        log.warn("server-side fallbacks rejected; continuing without", error.message)
        fallbacksRejected = true
        continue
      }
      throw error
    }
  }
}

/** Exposed for tests. */
export const __test = { buildParams, toMessages }
export type { ModelMessage }
