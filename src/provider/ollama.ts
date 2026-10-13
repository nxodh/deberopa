import { VERSION } from "../global"
import { createLogger } from "../util/log"
import { EMPTY_USAGE, ProviderError, type FinishReason, type StreamEvent, type StreamInput, type Usage } from "./types"

const log = createLogger("ollama")

/**
 * Ollama's own chat API rather than its OpenAI-compatible one: only the native API lets us
 * set `num_ctx`. Without it Ollama loads models with a 2-4K window and silently drops
 * everything that does not fit, which an agent prompt (system text + tools) overflows at once.
 */
export function numCtx(input: Pick<StreamInput, "model">): number {
  const explicit = Number((input.model.options as any)?.num_ctx)
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit)
  return input.model.limit.context > 0 ? input.model.limit.context : 8192
}

function toMessages(input: StreamInput): any[] {
  const out: any[] = []
  const system = input.system.filter((s) => s.trim() !== "").join("\n\n")
  if (system) out.push({ role: "system", content: system })
  const vision = input.model.attachment

  for (const message of input.messages) {
    if (message.role === "user") {
      const text = message.content.map((p) => (p.type === "text" ? p.text : "")).filter(Boolean).join("\n")
      const images = vision ? message.content.filter((p) => p.type === "image" && p.mime.startsWith("image/")).map((p) => (p.type === "image" ? p.data : "")) : []
      if (text.trim() === "" && images.length === 0) continue
      out.push({ role: "user", content: text, ...(images.length ? { images } : {}) })
    } else if (message.role === "assistant") {
      const text = message.content.map((p) => (p.type === "text" ? p.text : "")).join("")
      const calls = message.content.flatMap((p) =>
        p.type === "tool-call" ? [{ function: { name: p.name, arguments: p.input && typeof p.input === "object" ? p.input : {} } }] : [],
      )
      if (text.trim() === "" && calls.length === 0) continue
      out.push({ role: "assistant", content: text, ...(calls.length ? { tool_calls: calls } : {}) })
    } else {
      const images: string[] = []
      for (const result of message.results) {
        out.push({ role: "tool", tool_name: result.name, content: result.output === "" ? "(no output)" : result.output })
        if (vision) for (const file of result.attachments ?? []) if (file.mime.startsWith("image/")) images.push(file.data)
      }
      if (images.length) out.push({ role: "user", content: "Attached output from the tool call above:", images })
    }
  }
  return out
}

/**
 * Ollama reuses the KV cache of a shared prompt prefix and then reports only the tokens it
 * evaluated this time as `prompt_eval_count`, so a long conversation can look like 300 tokens.
 * The context-usage figure and auto-compaction need the real size, so estimate it from the
 * request. Calibrated on a real run (6.6K chars of JSON -> 1.6K tokens, 4.1 chars/token) and
 * deliberately pessimistic: CJK text costs about a token per character.
 */
export function estimatePromptTokens(body: { messages?: unknown; tools?: unknown }): number {
  const json = JSON.stringify({ messages: body.messages ?? [], tools: body.tools ?? [] })
  let ascii = 0
  for (let i = 0; i < json.length; i++) if (json.charCodeAt(i) < 128) ascii++
  const messageCount = Array.isArray(body.messages) ? body.messages.length : 0
  return Math.ceil(ascii / 3.5 + (json.length - ascii) + messageCount * 6)
}

export function buildBody(input: StreamInput) {
  const { model } = input
  const options: Record<string, unknown> = { num_ctx: numCtx(input) }
  // An unbounded reply lets a looping model run until the context is full.
  options.num_predict = input.maxOutputTokens ?? (model.limit.output > 0 ? model.limit.output : 8192)
  if (input.temperature !== undefined) options.temperature = input.temperature
  if (input.topP !== undefined) options.top_p = input.topP
  for (const [key, value] of Object.entries((model.options as Record<string, unknown>) ?? {})) {
    if (key !== "num_ctx" && key !== "think" && key !== "keep_alive") options[key] = value
  }

  const body: Record<string, unknown> = {
    model: model.id,
    messages: toMessages(input),
    stream: true,
    // keep the model in memory between turns: reloading a large model costs tens of seconds
    keep_alive: (model.options as any)?.keep_alive ?? "30m",
    options,
  }
  if (input.tools.length) {
    body.tools = input.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }))
  }
  const think = (model.options as any)?.think
  if (think !== undefined) body.think = think
  else if (model.reasoning) {
    // gpt-oss takes a level; other thinking models take a boolean
    body.think = /gpt-oss/i.test(model.id) ? (input.effort === "low" ? "low" : input.effort === "medium" ? "medium" : "high") : true
  }
  return body
}

async function* ndjson(body: ReadableStream<Uint8Array>): AsyncGenerator<any> {
  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buffer = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index: number
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (!line) continue
        try {
          yield JSON.parse(line)
        } catch {
          log.debug("skipping unparsable line", line.slice(0, 200))
        }
      }
    }
    const rest = buffer.trim()
    if (rest) {
      try {
        yield JSON.parse(rest)
      } catch {}
    }
  } finally {
    reader.releaseLock()
  }
}

function explain(status: number, message: string, model: string, baseURL: string): ProviderError {
  if (status === 404 || /not found/i.test(message)) {
    return new ProviderError(`Ollama has no model "${model}". Download it with: ollama pull ${model}`, { status: 404, kind: "invalid-request" })
  }
  if (/does not support tools/i.test(message)) {
    return new ProviderError(
      `The model "${model}" does not support tool calls, so the agent cannot use it. Pick a model that lists "tools" under capabilities (for example qwen3, llama3.1 or mistral-nemo).`,
      { status, kind: "invalid-request" },
    )
  }
  if (/does not support thinking/i.test(message)) {
    return new ProviderError(`The model "${model}" does not support thinking. Set "options": { "think": false } for it in your config.`, { status, kind: "invalid-request" })
  }
  if (/out of memory|insufficient memory|requires more system memory/i.test(message)) {
    return new ProviderError(`Ollama ran out of memory loading "${model}": ${message}. Try a smaller model, or lower the context size (models.<id>.limit.context).`, { status, kind: "invalid-request" })
  }
  return new ProviderError(`Ollama (${baseURL}): ${message}`, { status })
}

export async function* streamOllama(input: StreamInput): AsyncGenerator<StreamEvent> {
  const { provider, model } = input
  const baseURL = (provider.baseURL ?? "http://127.0.0.1:11434").replace(/\/+$/, "").replace(/\/v1$/, "")
  const body = buildBody(input)
  const ctx = (body.options as any).num_ctx as number

  const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": `vedecaps/${VERSION}`, ...provider.headers }
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`

  let response: Response
  try {
    response = await fetch(`${baseURL}/api/chat`, {
      redirect: "error",
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: provider.timeout ? AbortSignal.any([...(input.signal ? [input.signal] : []), AbortSignal.timeout(provider.timeout)]) : input.signal,
    })
  } catch (err) {
    if (input.signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
      throw Object.assign(new Error("Aborted"), { name: "AbortError" })
    }
    throw new ProviderError(`Could not reach Ollama at ${baseURL}. Is it running? Start it with: ollama serve`, { kind: "network", retryable: false })
  }

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "")
    let message = text.slice(0, 1000) || response.statusText
    try {
      message = JSON.parse(text).error ?? message
    } catch {}
    throw explain(response.status, String(message), model.id, baseURL)
  }

  const estimated = estimatePromptTokens(body as { messages: unknown; tools: unknown })
  let usage: Usage = { ...EMPTY_USAGE }
  let reason: FinishReason = "stop"
  let calls = 0
  let thinking = false

  for await (const line of ndjson(response.body)) {
    if (line.error) throw explain(500, String(line.error), model.id, baseURL)
    const message = line.message
    if (message) {
      if (typeof message.thinking === "string" && message.thinking !== "") {
        thinking = true
        yield { type: "reasoning-delta", text: message.thinking }
      }
      if (typeof message.content === "string" && message.content !== "") {
        if (thinking) {
          thinking = false
          yield { type: "reasoning-end" }
        }
        yield { type: "text-delta", text: message.content }
      }
      for (const call of message.tool_calls ?? []) {
        const name = call?.function?.name
        if (typeof name !== "string" || name === "") continue
        if (thinking) {
          thinking = false
          yield { type: "reasoning-end" }
        }
        let args: unknown = call.function.arguments ?? {}
        let invalid: string | undefined
        if (typeof args === "string") {
          try {
            args = args.trim() === "" ? {} : JSON.parse(args)
          } catch {
            invalid = "The tool input was not valid JSON. Send the complete call again."
          }
        }
        const id = `call_${calls}_${Date.now().toString(36)}`
        calls++
        yield { type: "tool-input-start", id, name }
        yield { type: "tool-call", id, name, input: args, invalid }
      }
    }
    if (line.done) {
      const reported = line.prompt_eval_count ?? 0
      usage = { ...EMPTY_USAGE, input: Math.max(reported, estimated), output: line.eval_count ?? 0 }
      if (line.done_reason === "length") reason = "length"
      // The prompt exactly filled the window: Ollama has already dropped the oldest part of it.
      if (usage.input >= ctx - 8) log.warn(`prompt filled the whole ${ctx}-token window of ${model.id}; older context was truncated`)
    }
  }
  if (thinking) yield { type: "reasoning-end" }
  yield { type: "finish", reason: calls > 0 && reason !== "length" ? "tool-calls" : reason, usage }
}

export const __test = { buildBody, toMessages, estimatePromptTokens }
