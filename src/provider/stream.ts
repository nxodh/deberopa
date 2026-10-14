import { streamAnthropic } from "./anthropic"
import { streamOllama } from "./ollama"
import { streamOpenAI } from "./openai"
import { withCompat } from "./compat"
import { limiterFor, type Limiter, type Priority } from "./limiter"
import type { StreamEvent, StreamInput } from "./types"

function streamModelUnlimited(input: StreamInput): AsyncGenerator<StreamEvent> {
  if (input.provider.protocol === "anthropic") return streamAnthropic(input)
  const raw = input.provider.protocol === "ollama" ? streamOllama(input) : streamOpenAI(input)
  // Hosted APIs return clean structured events. Servers on this machine (or its network) get
  // the compatibility layer for <think> tags and tool calls written as text.
  if (!input.provider.local) return raw
  return withCompat(raw, { toolNames: input.tools.map((t) => t.name), thinkTags: true, textToolCalls: input.tools.length > 0 })
}

/** Holds a slot for exactly as long as the stream is being read, and always lets go of it. */
async function* limited(inner: AsyncGenerator<StreamEvent>, limiter: Limiter, signal?: AbortSignal, priority?: Priority): AsyncGenerator<StreamEvent> {
  let release: (() => void) | undefined
  try {
    release = await limiter.acquire(signal, priority)
    yield* inner
  } finally {
    release?.()
    // a consumer that stops early, or an acquire that was aborted, must not leave the request open
    try {
      await inner.return(undefined as never)
    } catch {}
  }
}

export function streamModel(input: StreamInput): AsyncGenerator<StreamEvent> {
  const inner = streamModelUnlimited(input)
  const max = input.provider.maxConcurrency
  if (!max) return inner
  return limited(inner, limiterFor(`${input.provider.id}@${input.provider.baseURL ?? ""}`, max), input.signal, input.priority)
}

/** One-shot text generation for titles and summaries. It yields to real work when slots are scarce. */
export async function generateText(input: Omit<StreamInput, "tools">): Promise<string> {
  let text = ""
  for await (const event of streamModel({ ...input, tools: [], priority: input.priority ?? "low" })) {
    if (event.type === "text-delta") text += event.text
  }
  return text.trim()
}
