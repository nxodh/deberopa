import { streamAnthropic } from "./anthropic"
import { streamOpenAI } from "./openai"
import type { StreamEvent, StreamInput } from "./types"

export function streamModel(input: StreamInput): AsyncGenerator<StreamEvent> {
  return input.provider.protocol === "anthropic" ? streamAnthropic(input) : streamOpenAI(input)
}

/** One-shot text generation for titles and summaries. */
export async function generateText(input: Omit<StreamInput, "tools">): Promise<string> {
  let text = ""
  for await (const event of streamModel({ ...input, tools: [] })) {
    if (event.type === "text-delta") text += event.text
  }
  return text.trim()
}
