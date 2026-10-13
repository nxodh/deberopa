import { VERSION } from "../global"
import { redact } from "../util/redact"
import { parseTextToolCalls } from "./compat"

/**
 * Does this server turn a "use the tool" request into a tool call? One non-streaming request, sent
 * straight to the server (not through the recovery layer, so that layer cannot hide the answer).
 * The body matches Diparnux's own `serve toolcheck`, so the two tools' results explain each other.
 */
export type ToolCheckStatus = "ok" | "recovered" | "failed" | "unauthorized" | "error"

export interface ToolCheckResult {
  status: ToolCheckStatus
  /** Round trip in milliseconds. */
  ms: number
  detail?: string
}

const TOOL = "get_time"

export const TOOLCHECK_BODY = (model: string) => ({
  model,
  messages: [{ role: "user", content: "What time is it in Seoul right now? Use the get_time tool." }],
  tools: [
    {
      type: "function",
      function: {
        name: TOOL,
        description: "Get the current time in a city.",
        parameters: { type: "object", properties: { city: { type: "string", description: "City name" } }, required: ["city"] },
      },
    },
  ],
  tool_choice: "auto",
  max_tokens: 128,
  temperature: 0,
  stream: false,
})

export async function checkToolCalling(opts: {
  /** OpenAI-compatible base URL, ending in /v1. */
  baseURL: string
  model: string
  apiKey?: string
  headers?: Record<string, string>
  timeoutMs?: number
}): Promise<ToolCheckResult> {
  const started = Date.now()
  const done = (status: ToolCheckStatus, detail?: string): ToolCheckResult => ({ status, ms: Date.now() - started, detail })
  const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": `vedecaps/${VERSION}`, ...opts.headers }
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`

  let response: Response
  try {
    response = await fetch(`${opts.baseURL.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(TOOLCHECK_BODY(opts.model)),
      redirect: "error",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 90_000),
    })
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")
    return done("error", timedOut ? "the server did not answer in time (is the model still loading?)" : redact(err instanceof Error ? err.message : String(err)))
  }

  if (response.status === 401 || response.status === 403) return done("unauthorized")
  const raw = await response.text().catch(() => "")
  if (!response.ok) {
    let message = raw.slice(0, 300)
    try {
      const parsed = JSON.parse(raw)
      message = parsed?.error?.message ?? parsed?.message ?? message
    } catch {}
    const busy = response.status === 429 ? "the server is busy (HTTP 429); try again in a moment" : `HTTP ${response.status}`
    return done("error", `${busy}${message && response.status !== 429 ? `: ${redact(String(message)).slice(0, 200)}` : ""}`)
  }

  let message: any
  try {
    message = JSON.parse(raw)?.choices?.[0]?.message
  } catch {
    return done("failed", "the answer was not an OpenAI-style chat completion")
  }
  const call = message?.tool_calls?.[0]?.function
  if (call && call.name === TOOL) {
    try {
      const args = typeof call.arguments === "string" ? JSON.parse(call.arguments) : call.arguments
      if (args && typeof args === "object" && !Array.isArray(args)) return done("ok")
    } catch {}
    return done("failed", "the tool call had arguments that are not a JSON object")
  }
  const content = typeof message?.content === "string" ? message.content : ""
  const recovered = parseTextToolCalls(content, [TOOL])
  if (recovered?.calls.length) return done("recovered")
  return done("failed", call ? `it called "${String(call.name).slice(0, 40)}", which was not offered` : "it answered in prose instead of calling the tool")
}
