import type { Timings, Usage } from "../provider/types"

export interface SessionInfo {
  id: string
  projectID: string
  directory: string
  parentID?: string
  title: string
  version: string
  time: { created: number; updated: number }
  /** Set while the session is rewound: messages from `messageID` on are hidden until redo or the next prompt. */
  revert?: { messageID: string; snapshot?: string; files?: string[] }
}

export interface TextPart {
  id: string
  type: "text"
  text: string
  /** Injected by the app (file contents, reminders) rather than typed by the user. */
  synthetic?: boolean
}

export interface ReasoningPart {
  id: string
  type: "reasoning"
  text: string
  time: { start: number; end?: number }
}

export interface FilePart {
  id: string
  type: "file"
  mime: string
  filename?: string
  /** base64 */
  data: string
}

export type ToolState =
  | { status: "pending"; input: unknown }
  | { status: "running"; input: unknown; title?: string; metadata?: Record<string, unknown>; time: { start: number } }
  | {
      status: "completed"
      input: unknown
      output: string
      title: string
      metadata: Record<string, unknown>
      time: { start: number; end: number }
      attachments?: { mime: string; filename?: string; data: string }[]
    }
  | { status: "error"; input: unknown; error: string; time: { start: number; end: number } }

export interface ToolPart {
  id: string
  type: "tool"
  callID: string
  tool: string
  /** Provider metadata that has to be echoed back with the call. */
  meta?: Record<string, unknown>
  /** The model wrote this call as text instead of a structured tool call; Deberopa recovered it. */
  viaText?: boolean
  state: ToolState
}

export interface StepStartPart {
  id: string
  type: "step-start"
  snapshot?: string
}

export interface PatchPart {
  id: string
  type: "patch"
  /** Snapshot taken before the step; the files changed since then. */
  hash: string
  files: string[]
}

export type Part = TextPart | ReasoningPart | FilePart | ToolPart | StepStartPart | PatchPart

export interface UserMessage {
  id: string
  sessionID: string
  role: "user"
  time: { created: number }
  agent: string
  model: { providerID: string; modelID: string }
  parts: Part[]
  /** Marks the synthetic request that precedes a compaction summary. */
  compaction?: boolean
}

export interface AssistantMessage {
  id: string
  sessionID: string
  role: "assistant"
  parentID: string
  time: { created: number; completed?: number }
  agent: string
  providerID: string
  modelID: string
  parts: Part[]
  tokens: Usage
  cost: number
  /** Server-reported timings for this response, when available. */
  timings?: Timings
  finish?: string
  error?: { name: string; message: string }
  /** This message is a compaction summary: history before it is no longer sent to the model. */
  summary?: boolean
  /** Provider-native content, replayed verbatim on the next request to the same model. */
  raw?: unknown
}

export type Message = UserMessage | AssistantMessage

export function messageText(message: Message, opts: { includeSynthetic?: boolean } = {}): string {
  return message.parts
    .filter((p): p is TextPart => p.type === "text" && (opts.includeSynthetic || !p.synthetic))
    .map((p) => p.text)
    .join("\n")
    .trim()
}

export function totalTokens(usage: Usage): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite
}
