import { createID } from "../util/id"
import { publish } from "../util/bus"
import { getAgent } from "../agent/agent"
import { getModel } from "../provider/provider"
import { streamModel } from "../provider/stream"
import { costOf, EMPTY_USAGE, ProviderError, type Model, type ModelMessage, type Usage } from "../provider/types"
import { addMessage, getMessages, touchMessage } from "./store"
import { dropOldest, toModelMessages } from "./convert"
import { totalTokens, type AssistantMessage, type TextPart, type UserMessage } from "./message"

const COMPACTION_SYSTEM = `You are summarising a conversation between a user and an AI coding agent so the work can continue in a fresh context window. The summary replaces the conversation: anything you leave out is lost.`

const COMPACTION_REQUEST = `Provide a detailed but concise summary of our conversation above, written for someone who will continue the work without access to it. Cover:

- What the user asked for, in their own terms, including constraints and preferences they stated.
- What has been done so far, and the current state of the work.
- Which files were read, created or modified (with paths) and why they matter.
- Decisions made and the reasoning behind them; approaches that were tried and failed.
- What remains to be done, in order, and the immediate next step.

Do not call any tools. Respond with the summary only.`

/** Has the conversation grown to the point where the next request may not fit? */
export function shouldCompact(tokens: Usage, model: Model, reserved?: number): boolean {
  const context = model.limit.context
  if (!context) return false
  const reserve = Math.max(1, Math.min(reserved ?? (model.limit.output || 8192), 32_000, Math.floor(context / 4)))
  return totalTokens(tokens) >= context - reserve
}

/**
 * Summarise the session so far. Appends a marker user message and an assistant message
 * flagged `summary`; later requests start from that summary instead of the full history.
 */
export async function compact(input: { sessionID: string; signal?: AbortSignal; auto?: boolean }): Promise<AssistantMessage | undefined> {
  const messages = await getMessages(input.sessionID)
  const lastUser = [...messages].reverse().find((m): m is UserMessage => m.role === "user")
  if (!lastUser) return undefined
  const { provider, model } = await getModel(lastUser.model.providerID, lastUser.model.modelID)
  const agent = await getAgent(lastUser.agent)

  let history: ModelMessage[] = toModelMessages(messages)
  if (history.length === 0) return undefined

  const marker: UserMessage = {
    id: createID("message"),
    sessionID: input.sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: lastUser.agent,
    model: lastUser.model,
    compaction: true,
    parts: [{ id: createID("part"), type: "text", text: "Summarise the conversation so far.", synthetic: true }],
  }
  await addMessage(marker)

  const summary: AssistantMessage = {
    id: createID("message"),
    sessionID: input.sessionID,
    role: "assistant",
    parentID: marker.id,
    time: { created: Date.now() },
    agent: lastUser.agent,
    providerID: provider.id,
    modelID: model.id,
    parts: [],
    tokens: { ...EMPTY_USAGE },
    cost: 0,
    summary: true,
  }
  await addMessage(summary)
  publish("session.compacting", { sessionID: input.sessionID })

  const part: TextPart = { id: createID("part"), type: "text", text: "" }
  summary.parts.push(part)

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      part.text = ""
      for await (const event of streamModel({
        provider,
        model,
        system: [COMPACTION_SYSTEM],
        messages: [...history, { role: "user", content: [{ type: "text", text: COMPACTION_REQUEST }] }],
        tools: [],
        signal: input.signal,
        effort: agent?.effort ?? "medium",
      })) {
        if (event.type === "text-delta") {
          part.text += event.text
          await touchMessage(summary, { part, delta: event.text })
        } else if (event.type === "finish") {
          summary.tokens = event.usage
          summary.cost = costOf(model, event.usage)
          summary.finish = event.reason
        }
      }
      break
    } catch (err) {
      // The history itself may be too large to summarise in one go: shed the oldest half and retry.
      if (err instanceof ProviderError && err.kind === "context-overflow" && history.length > 2 && attempt < 3) {
        history = dropOldest(history)
        continue
      }
      summary.error = { name: err instanceof Error ? err.name : "Error", message: err instanceof Error ? err.message : String(err) }
      summary.time.completed = Date.now()
      await touchMessage(summary, { now: true })
      publish("session.compacted", { sessionID: input.sessionID })
      throw err
    }
  }

  if (part.text.trim() === "") summary.error = { name: "CompactionError", message: "The model returned an empty summary." }
  summary.time.completed = Date.now()
  await touchMessage(summary, { now: true })
  publish("session.compacted", { sessionID: input.sessionID })

  if (input.auto && !summary.error) {
    await addMessage({
      id: createID("message"),
      sessionID: input.sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: lastUser.agent,
      model: lastUser.model,
      parts: [
        {
          id: createID("part"),
          type: "text",
          synthetic: true,
          text: "The conversation was compacted to free up context. Continue with the task if there are remaining steps; otherwise stop and tell me where things stand.",
        },
      ],
    })
  }
  return summary
}
