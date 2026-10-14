import { VERSION } from "../global"
import { EMPTY_USAGE, ProviderError, type FinishReason, type StreamEvent, type StreamInput, type Usage } from "./types"
import { describeTlsError, hostOf, tlsInit } from "./tls"

/** Split an SSE byte stream into `data:` payloads. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ""
  const reader = body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index: number
      while ((index = buffer.search(/\r?\n/)) !== -1) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + (buffer[index] === "\r" ? 2 : 1))
        if (line.startsWith("data:")) yield line.slice(5).trimStart()
      }
    }
    const tail = buffer.trim()
    if (tail.startsWith("data:")) yield tail.slice(5).trimStart()
  } finally {
    reader.releaseLock()
  }
}

function toMessages(input: StreamInput): any[] {
  const out: any[] = []
  const system = input.system.filter((s) => s.trim() !== "").join("\n\n")
  if (system) out.push({ role: "system", content: system })

  for (const message of input.messages) {
    if (message.role === "user") {
      const images = message.content.filter((p) => p.type === "image" && p.mime.startsWith("image/"))
      if (images.length === 0 || !input.model.attachment) {
        const text = message.content.map((p) => (p.type === "text" ? p.text : "")).filter(Boolean).join("\n")
        if (text.trim() !== "") out.push({ role: "user", content: text })
        continue
      }
      out.push({
        role: "user",
        content: message.content.flatMap((p): any[] => {
          if (p.type === "text") return p.text.trim() === "" ? [] : [{ type: "text", text: p.text }]
          if (!p.mime.startsWith("image/")) return []
          return [{ type: "image_url", image_url: { url: `data:${p.mime};base64,${p.data}` } }]
        }),
      })
    } else if (message.role === "assistant") {
      const text = message.content.map((p) => (p.type === "text" ? p.text : "")).join("")
      const calls = message.content.flatMap((p) =>
        p.type === "tool-call"
          ? [
              {
                id: p.id,
                type: "function",
                function: { name: p.name, arguments: JSON.stringify(p.input ?? {}) },
                // e.g. Gemini thought signatures, which must be echoed back untouched
                ...(p.meta?.extra_content ? { extra_content: p.meta.extra_content } : {}),
              },
            ]
          : [],
      )
      if (text.trim() === "" && calls.length === 0) continue
      const entry: any = { role: "assistant", content: text === "" ? null : text }
      if (calls.length) entry.tool_calls = calls
      out.push(entry)
    } else {
      const images: any[] = []
      for (const result of message.results) {
        out.push({ role: "tool", tool_call_id: result.id, content: result.output === "" ? "(no output)" : result.output })
        for (const file of result.attachments ?? []) {
          if (file.mime.startsWith("image/")) images.push({ type: "image_url", image_url: { url: `data:${file.mime};base64,${file.data}` } })
        }
      }
      // Chat completions has no image slot in tool results, so attach them as a follow-up user turn.
      if (images.length && input.model.attachment) {
        out.push({ role: "user", content: [{ type: "text", text: "Attached output from the tool call above:" }, ...images] })
      }
    }
  }
  return out
}

function mapFinish(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case "stop":
      return "stop"
    case "tool_calls":
    case "function_call":
      return "tool-calls"
    case "length":
      return "length"
    case "content_filter":
      return "content-filter"
    default:
      return "unknown"
  }
}

function buildBody(input: StreamInput) {
  const { model, provider } = input
  const body: any = {
    model: model.id,
    messages: toMessages(input),
    stream: true,
    stream_options: { include_usage: true },
    ...model.options,
  }
  if (input.tools.length) {
    body.tools = input.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }))
  }
  // Output limits and sampling stay at provider defaults unless explicitly configured:
  // parameter names and allowed ranges differ too much across "compatible" APIs to guess.
  if (input.maxOutputTokens !== undefined) {
    if (provider.id === "openai") body.max_completion_tokens = input.maxOutputTokens
    else body.max_tokens = input.maxOutputTokens
  }
  if (input.temperature !== undefined && model.temperature) body.temperature = input.temperature
  if (input.topP !== undefined && model.temperature) body.top_p = input.topP
  if (input.effort && model.reasoning && provider.id === "openai") {
    body.reasoning_effort = input.effort === "max" || input.effort === "xhigh" ? "high" : input.effort
  }
  return body
}

export async function* streamOpenAI(input: StreamInput): AsyncGenerator<StreamEvent> {
  const { provider } = input
  const url = `${(provider.baseURL ?? "").replace(/\/+$/, "")}/chat/completions`
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "User-Agent": `deberopa/${VERSION}`,
    ...provider.headers,
  }
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`
  if (provider.id === "openrouter") {
    headers["HTTP-Referer"] ??= "https://github.com/nxodh/deberopa"
    headers["X-Title"] ??= "Deberopa"
  }

  let response: Response
  try {
    response = await fetch(url, { method: "POST", headers, body: JSON.stringify(buildBody(input)), signal: input.signal, redirect: "error", ...tlsInit(provider.tls) })
  } catch (err) {
    if (input.signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
      const abort = new Error("Aborted")
      abort.name = "AbortError"
      throw abort
    }
    // a certificate that is refused will be refused again: say how to fix it and do not retry
    const advice = describeTlsError(err, { providerID: provider.id, host: hostOf(url), hasCA: !!provider.tls })
    if (advice) throw new ProviderError(`Could not connect to ${provider.name} (${url}): ${advice}`, { kind: "network", retryable: false })
    throw new ProviderError(`Could not reach ${provider.name} (${url}): ${err instanceof Error ? err.message : String(err)}`, {
      kind: "network",
    })
  }

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "")
    let message = text.slice(0, 2000) || response.statusText
    try {
      const parsed = JSON.parse(text)
      const inner = Array.isArray(parsed) ? parsed[0] : parsed
      message = inner?.error?.message ?? inner?.message ?? (typeof inner?.error === "string" ? inner.error : message)
    } catch {}
    const retryAfter = Number(response.headers.get("retry-after"))
    throw new ProviderError(`${provider.name}: ${message}`, {
      status: response.status,
      retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
    })
  }

  const calls = new Map<number, { id: string; name: string; args: string; meta?: Record<string, unknown>; started: boolean }>()
  let finish: string | null | undefined
  let usage: Usage = { ...EMPTY_USAGE }
  let reasoningOpen = false
  let sawContent = false

  for await (const data of sseData(response.body)) {
    if (data === "[DONE]") break
    let chunk: any
    try {
      chunk = JSON.parse(data)
    } catch {
      continue
    }
    if (chunk.error) {
      const message = chunk.error.message ?? JSON.stringify(chunk.error)
      throw new ProviderError(`${provider.name}: ${message}`, { status: typeof chunk.error.code === "number" ? chunk.error.code : undefined })
    }
    if (chunk.usage) {
      const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? chunk.usage.prompt_cache_hit_tokens ?? 0
      usage = {
        input: Math.max(0, (chunk.usage.prompt_tokens ?? 0) - cached),
        output: chunk.usage.completion_tokens ?? 0,
        reasoning: chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0,
        cacheRead: cached,
        cacheWrite: 0,
      }
    }
    const choice = chunk.choices?.[0]
    if (!choice) continue
    const delta = choice.delta ?? {}

    const reasoning = delta.reasoning_content ?? delta.reasoning
    if (typeof reasoning === "string" && reasoning !== "") {
      reasoningOpen = true
      yield { type: "reasoning-delta", text: reasoning }
    }
    if (typeof delta.content === "string" && delta.content !== "") {
      if (reasoningOpen) {
        reasoningOpen = false
        yield { type: "reasoning-end" }
      }
      sawContent = true
      yield { type: "text-delta", text: delta.content }
    }
    for (const call of delta.tool_calls ?? []) {
      const index: number = call.index ?? 0
      let entry = calls.get(index)
      if (!entry) calls.set(index, (entry = { id: "", name: "", args: "", started: false }))
      if (call.id) entry.id = call.id
      if (call.function?.name) entry.name += call.function.name
      if (typeof call.function?.arguments === "string") entry.args += call.function.arguments
      if (call.extra_content) entry.meta = { ...entry.meta, extra_content: call.extra_content }
      if (!entry.started && entry.name) {
        entry.started = true
        if (!entry.id) entry.id = `call_${index}_${Date.now().toString(36)}`
        if (reasoningOpen) {
          reasoningOpen = false
          yield { type: "reasoning-end" }
        }
        yield { type: "tool-input-start", id: entry.id, name: entry.name }
      }
    }
    if (choice.finish_reason) finish = choice.finish_reason
  }

  if (reasoningOpen) yield { type: "reasoning-end" }

  const cutOff = finish === "length"
  let emittedCalls = 0
  for (const [index, entry] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
    if (!entry.name) continue
    if (!entry.id) entry.id = `call_${index}_${Date.now().toString(36)}`
    let parsed: unknown = {}
    let invalid: string | undefined
    try {
      parsed = entry.args.trim() === "" ? {} : JSON.parse(entry.args)
    } catch {
      invalid = "The tool input was not valid JSON (it may have been cut off). Send the complete call again."
    }
    if (cutOff && !invalid) invalid = "The response was cut off before this tool call completed. Send it again."
    emittedCalls++
    yield { type: "tool-call", id: entry.id, name: entry.name, input: parsed, invalid, meta: entry.meta }
  }

  let reason = mapFinish(finish)
  // Some servers report "stop" even when they returned tool calls.
  if (emittedCalls > 0 && reason !== "length") reason = "tool-calls"
  if (reason === "unknown" && (sawContent || emittedCalls === 0)) reason = "stop"
  yield { type: "finish", reason, usage }
}

export const __test = { buildBody, toMessages }
