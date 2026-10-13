import type { AssistantContent, ModelMessage, ToolResultContent, UserContent } from "../provider/types"
import type { Message } from "./message"
import { BUILD_SWITCH, PLAN_REMINDER } from "./system"

/** Index of the newest finished compaction summary, or -1. Everything before it is superseded. */
export function lastSummaryIndex(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === "assistant" && m.summary && m.time.completed && !m.error) return i
  }
  return -1
}

/** Translate stored messages into the provider-neutral conversation sent to a model. */
export function toModelMessages(messages: Message[]): ModelMessage[] {
  const out: ModelMessage[] = []
  const start = lastSummaryIndex(messages)
  if (start >= 0) {
    const summary = messages[start]!
    const text = summary.parts.map((p) => (p.type === "text" ? p.text : "")).join("")
    out.push({ role: "user", content: [{ type: "text", text: "What did we do so far?" }] })
    out.push({ role: "assistant", content: [{ type: "text", text }] })
  }

  let previousAgent: string | undefined
  for (let i = start + 1; i < messages.length; i++) {
    const message = messages[i]!
    if (message.role === "user") {
      if (message.compaction) continue
      const content: UserContent[] = []
      for (const part of message.parts) {
        if (part.type === "text" && part.text.trim() !== "") content.push({ type: "text", text: part.text })
        else if (part.type === "file") content.push({ type: "image", mime: part.mime, data: part.data })
      }
      // Mode reminders are derived from the stored agent, so they are identical on every request.
      if (message.agent === "plan") content.push({ type: "text", text: PLAN_REMINDER })
      else if (previousAgent === "plan" && message.agent === "build") content.push({ type: "text", text: BUILD_SWITCH })
      previousAgent = message.agent
      if (content.length) out.push({ role: "user", content })
      continue
    }

    if (message.summary) continue
    const content: AssistantContent[] = []
    const results: ToolResultContent[] = []
    for (const part of message.parts) {
      if (part.type === "text" && part.text.trim() !== "") content.push({ type: "text", text: part.text })
      else if (part.type === "tool") {
        content.push({ type: "tool-call", id: part.callID, name: part.tool, input: part.state.input ?? {}, meta: part.meta })
        const state = part.state
        if (state.status === "completed") {
          results.push({ id: part.callID, name: part.tool, output: state.output, attachments: state.attachments })
        } else if (state.status === "error") {
          results.push({ id: part.callID, name: part.tool, output: state.error, isError: true })
        } else {
          // The run stopped before this call finished; the model still needs an answer for it.
          results.push({ id: part.callID, name: part.tool, output: "[Tool execution was interrupted]", isError: true })
        }
      }
    }
    if (content.length === 0) continue
    out.push({
      role: "assistant",
      content,
      raw: message.raw !== undefined ? { providerID: message.providerID, modelID: message.modelID, content: message.raw } : undefined,
    })
    if (results.length) out.push({ role: "tool", results })
  }
  return out
}

/** Drop the oldest part of a conversation without leaving tool results orphaned from their calls. */
export function dropOldest(messages: ModelMessage[], fraction = 0.5): ModelMessage[] {
  let index = Math.max(1, Math.floor(messages.length * fraction))
  while (index < messages.length && messages[index]!.role !== "user") index++
  return messages.slice(index)
}
