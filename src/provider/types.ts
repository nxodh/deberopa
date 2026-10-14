import type { JSONSchema } from "../tool/tool"
import { redact } from "../util/redact"
import type { DiparnuxInfo } from "./local"
import type { CaSource, ProviderTls } from "./tls"

export interface Model {
  id: string
  providerID: string
  name: string
  limit: { context: number; output: number }
  /** USD per million tokens. */
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
  reasoning: boolean
  toolCall: boolean
  attachment: boolean
  temperature: boolean
  releaseDate?: string
  /** Extra request fields sent to the server (sampling options, num_ctx, ...). Not for metadata. */
  options?: Record<string, unknown>
  /** Descriptive facts about a locally served model. */
  meta?: { details?: string; paramsB?: number }
}

export interface ProviderInfo {
  id: string
  name: string
  protocol: "anthropic" | "openai" | "ollama"
  /** A server on this machine or its network (loopback, private ranges). */
  local?: boolean
  baseURL?: string
  env: string[]
  apiKey?: string
  headers?: Record<string, string>
  timeout?: number
  /** Where the credential came from; "none" means the provider is known but not usable yet. */
  source: "env" | "auth" | "config" | "local" | "none"
  models: Record<string, Model>
  /** What a Diparnux gateway reported about itself; unset for every other server. */
  diparnux?: DiparnuxInfo
  /** At most this many model requests to this server at once. Unset means no limit. */
  maxConcurrency?: number
  /** Where `maxConcurrency` came from: the user's `options.max_concurrency`, or the gateway's slot count. */
  maxConcurrencySource?: "config" | "diparnux"
  /** Set when `options.max_concurrency` was present but unusable (so `debug` can say why). */
  maxConcurrencyIgnored?: string
  /** The CAs this provider trusts instead of the system store (`options.ca`). Passed to every request to it. */
  tls?: ProviderTls
  /** Where those CAs came from, for `debug`. */
  tlsSources?: CaSource[]
  /** The provider cannot be used, and why. Set when `options.ca` is unusable; there is no fallback. */
  problem?: string
}

export type UserContent = { type: "text"; text: string } | { type: "image"; mime: string; data: string }

export type AssistantContent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; id: string; name: string; input: unknown; meta?: Record<string, unknown> }

export interface ToolResultContent {
  id: string
  name: string
  output: string
  isError?: boolean
  attachments?: { mime: string; data: string }[]
}

export type ModelMessage =
  | { role: "user"; content: UserContent[] }
  | {
      role: "assistant"
      content: AssistantContent[]
      /** Provider-native content of this turn, replayed verbatim when the same model continues. */
      raw?: { providerID: string; modelID: string; content: unknown }
    }
  | { role: "tool"; results: ToolResultContent[] }

export interface ToolSpec {
  name: string
  description: string
  parameters: JSONSchema
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max"

export interface StreamInput {
  provider: ProviderInfo
  model: Model
  system: string[]
  messages: ModelMessage[]
  tools: ToolSpec[]
  signal?: AbortSignal
  maxOutputTokens?: number
  temperature?: number
  topP?: number
  effort?: Effort
  /** Order in which waiting requests are served when the provider limits concurrency. Default "normal". */
  priority?: "normal" | "low"
}

export interface Usage {
  /** Uncached input tokens. */
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export type FinishReason = "stop" | "tool-calls" | "length" | "refusal" | "content-filter" | "unknown"

export type StreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "reasoning-end" }
  | { type: "tool-input-start"; id: string; name: string }
  | { type: "tool-call"; id: string; name: string; input: unknown; invalid?: string; meta?: Record<string, unknown> }
  | { type: "finish"; reason: FinishReason; usage: Usage; raw?: unknown; servedBy?: string; message?: string }

export class ProviderError extends Error {
  status?: number
  retryable: boolean
  kind: "auth" | "rate-limit" | "overloaded" | "context-overflow" | "invalid-request" | "network" | "unknown"
  retryAfterMs?: number

  constructor(message: string, opts: { status?: number; retryable?: boolean; kind?: ProviderError["kind"]; retryAfterMs?: number } = {}) {
    // Servers sometimes echo (part of) the key back in auth errors.
    super(redact(message))
    this.name = "ProviderError"
    this.status = opts.status
    this.kind = opts.kind ?? classify(opts.status, message)
    this.retryable = opts.retryable ?? (this.kind === "rate-limit" || this.kind === "overloaded" || this.kind === "network")
    this.retryAfterMs = opts.retryAfterMs
  }
}

const OVERFLOW = /prompt is too long|context[_ ]length|context window|maximum context|too many tokens|exceeds? the (model'?s? )?(maximum|context)|input is too long|reduce the length/i

function classify(status: number | undefined, message: string): ProviderError["kind"] {
  if (OVERFLOW.test(message)) return "context-overflow"
  if (status === 401 || status === 403) return "auth"
  if (status === 429) return "rate-limit"
  if (status === 529 || status === 503 || status === 502 || status === 500 || status === 504) return "overloaded"
  if (status === 400 || status === 404 || status === 422 || status === 413) return "invalid-request"
  if (status === undefined) return "network"
  return "unknown"
}

export const EMPTY_USAGE: Usage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }

export function costOf(model: Model, usage: Usage): number {
  const c = model.cost
  return (
    (usage.input * c.input + usage.output * c.output + usage.cacheRead * c.cacheRead + usage.cacheWrite * c.cacheWrite) / 1_000_000
  )
}
