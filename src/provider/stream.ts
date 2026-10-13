import { streamAnthropic } from "./anthropic"
import { streamOllama } from "./ollama"
import { streamOpenAI } from "./openai"
import { withCompat } from "./compat"
import type { StreamEvent, StreamInput } from "./types"

export function streamModel(input: StreamInput): AsyncGenerator<StreamEvent> {
  if (input.provider.protocol === "anthropic") return streamAnthropic(input)
  const raw = input.provider.protocol === "ollama" ? streamOllama(input) : streamOpenAI(input)
  // Hosted APIs return clean structured events. Servers on this machine (or its network) get
  // the compatibility layer for <think> tags and tool calls written as text.
  if (!input.provider.local) return raw
  return withCompat(raw, { toolNames: input.tools.map((t) => t.name), thinkTags: true, textToolCalls: input.tools.length > 0 })
}

/** One-shot text generation for titles and summaries. */
export async function generateText(input: Omit<StreamInput, "tools">): Promise<string> {
  let text = ""
  for await (const event of streamModel({ ...input, tools: [] })) {
    if (event.type === "text-delta") text += event.text
  }
  return text.trim()
}
