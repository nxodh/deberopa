import type { StreamEvent } from "./types"

/**
 * Local models are less tidy than hosted APIs: reasoning arrives wrapped in <think> tags inside
 * the content, and models without native tool calling (or with a broken chat template) write
 * their tool calls as text. This layer turns both back into the structured events the agent
 * loop expects, so it never has to know where the model runs.
 */

export interface ParsedCall {
  name: string
  args: Record<string, unknown>
}

function pickName(raw: unknown, names: Set<string>): string | undefined {
  if (typeof raw !== "string") return undefined
  const cleaned = raw.trim().replace(/^functions?[./]/i, "")
  if (names.has(cleaned)) return cleaned
  const lower = cleaned.toLowerCase()
  for (const name of names) if (name.toLowerCase() === lower) return name
  return undefined
}

function asArgs(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return {}
  if (typeof value === "string") {
    const text = value.trim()
    if (text === "") return {}
    try {
      const parsed = JSON.parse(text)
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  }
  return typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/** Accepts the shapes models actually produce: {name, arguments}, {function: {...}}, {tool, parameters}, arrays of those. */
function fromJSON(value: unknown, names: Set<string>): ParsedCall[] | undefined {
  if (Array.isArray(value)) {
    const calls = value.map((v) => fromJSON(v, names)).filter((c): c is ParsedCall[] => !!c).flat()
    return calls.length > 0 && calls.length === value.length ? calls : undefined
  }
  if (!value || typeof value !== "object") return undefined
  const obj = value as Record<string, any>
  const inner = obj.function && typeof obj.function === "object" ? obj.function : obj
  const name = pickName(inner.name ?? inner.tool ?? inner.tool_name ?? (typeof obj.function === "string" ? obj.function : undefined), names)
  if (!name) return undefined
  const args = asArgs(inner.arguments ?? inner.parameters ?? inner.args ?? inner.input)
  return args ? [{ name, args }] : undefined
}

const looseValue = (raw: string): unknown => {
  const text = raw.replace(/^\n+|\n+$/g, "")
  if (/^(true|false|null|-?\d+(\.\d+)?)$/.test(text.trim())) return JSON.parse(text.trim())
  if (/^[[{]/.test(text.trim())) {
    try {
      return JSON.parse(text)
    } catch {}
  }
  return text
}

/**
 * Pull tool calls out of free text. Returns the calls and whatever text is left over,
 * or undefined when nothing in the text is a call to a known tool.
 */
export function parseTextToolCalls(text: string, toolNames: Iterable<string>): { calls: ParsedCall[]; rest: string } | undefined {
  const names = new Set(toolNames)
  if (names.size === 0 || text.trim() === "") return undefined
  const calls: ParsedCall[] = []
  let rest = text

  // <tool_call>{"name": ..., "arguments": ...}</tool_call>   (Hermes / Qwen)
  rest = rest.replace(/<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/g, (whole, body: string) => {
    try {
      const parsed = fromJSON(JSON.parse(body), names)
      if (parsed) {
        calls.push(...parsed)
        return ""
      }
    } catch {}
    // <tool_call><function=name>...</function></tool_call>
    return whole
  })

  // <function=name><parameter=key>value</parameter></function>   (Qwen3-Coder, Llama)
  rest = rest.replace(/<function=([^>\s]+)>([\s\S]*?)<\/function>/g, (whole, rawName: string, body: string) => {
    const name = pickName(rawName, names)
    if (!name) return whole
    const args: Record<string, unknown> = {}
    for (const m of body.matchAll(/<parameter=([^>\s]+)>([\s\S]*?)<\/parameter>/g)) args[m[1]!] = looseValue(m[2]!)
    calls.push({ name, args })
    return ""
  })
  rest = rest.replace(/<\/?tool_call>/g, "")

  // [TOOL_CALLS][{...}]   (Mistral)
  const mistral = /\[TOOL_CALLS\]\s*(\[[\s\S]*\]|\{[\s\S]*\})/.exec(rest)
  if (mistral) {
    try {
      const parsed = fromJSON(JSON.parse(mistral[1]!), names)
      if (parsed) {
        calls.push(...parsed)
        rest = rest.replace(mistral[0], "")
      }
    } catch {}
  }

  // <|python_tag|>{...}   (Llama 3.1)
  const python = /<\|python_tag\|>\s*(\{[\s\S]*\})/.exec(rest)
  if (python) {
    try {
      const parsed = fromJSON(JSON.parse(python[1]!), names)
      if (parsed) {
        calls.push(...parsed)
        rest = rest.replace(python[0], "")
      }
    } catch {}
  }

  if (calls.length === 0) {
    // the whole reply is JSON, optionally in a code fence
    const body = rest.trim().replace(/^```(?:json|tool_call|tool)?\s*/i, "").replace(/\s*```$/, "")
    if (/^[[{]/.test(body)) {
      try {
        const parsed = fromJSON(JSON.parse(body), names)
        if (parsed) return { calls: parsed, rest: "" }
      } catch {}
    }
    return undefined
  }
  return { calls, rest: rest.trim() }
}

const XML_TRIGGERS = ["<tool_call>", "<function=", "[TOOL_CALLS]", "<|python_tag|>"]
const OPEN = "<think>"
const CLOSE = "</think>"

/** Longest suffix of `text` that is a proper prefix of any of `words` (so a split tag is never emitted early). */
function partialSuffix(text: string, words: string[]): number {
  let best = 0
  for (const word of words) {
    for (let n = Math.min(word.length - 1, text.length); n > best; n--) {
      if (word.startsWith(text.slice(text.length - n))) {
        best = n
        break
      }
    }
  }
  return best
}

/** Does text that starts with this look like (the start of) a JSON tool call? "no" lets it stream. */
function jsonStart(trimmed: string): "yes" | "maybe" | "no" {
  if (trimmed === "") return "maybe"
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "yes"
  const fence = /^```(json|tool_call|tool)?\s*([{[])?/i.exec(trimmed)
  if (fence) {
    if (fence[2]) return "yes"
    if (/^```(json|tool_call|tool)?\s*$/i.test(trimmed)) return "maybe"
    return "no"
  }
  return /^`{1,2}$/.test(trimmed) ? "maybe" : "no"
}

export interface CompatOptions {
  toolNames: string[]
  /** Split <think>…</think> out of the text into reasoning events. */
  thinkTags?: boolean
  /** Recover tool calls that were written as text. */
  textToolCalls?: boolean
}

export async function* withCompat(source: AsyncGenerator<StreamEvent>, opts: CompatOptions): AsyncGenerator<StreamEvent> {
  const thinkTags = opts.thinkTags !== false
  const textCalls = opts.textToolCalls !== false && opts.toolNames.length > 0
  let inThink = false
  let thinkSeen = false
  let tagBuffer = ""        // text not yet classified (may end in half a tag)
  let held = ""             // candidate tool call text, kept until the stream ends
  let holding = false
  let released = false      // some visible text has been passed on
  let structured = 0
  let startDecision: "yes" | "maybe" | "no" = textCalls ? "maybe" : "no"
  let nextCall = 0

  // Route plain (non-think) text through the tool-call detector.
  function* emitText(chunk: string): Generator<StreamEvent> {
    if (chunk === "") return
    if (!textCalls || structured > 0) {
      released ||= chunk.trim() !== ""
      yield { type: "text-delta", text: chunk }
      return
    }
    if (holding) {
      held += chunk
      return
    }
    // anything still in `held` here is the tail of a tag that was split across chunks
    let pending = held + chunk
    held = ""
    if (!released && startDecision !== "no") {
      const decision = jsonStart(pending.trimStart())
      if (decision === "yes") {
        holding = true
        held = pending
        return
      }
      if (decision === "maybe") {
        held = pending
        return
      }
      startDecision = "no"
    }
    // XML-ish markers can appear after some prose.
    const at = XML_TRIGGERS.map((t) => pending.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0]
    if (at !== undefined) {
      const before = pending.slice(0, at)
      if (before !== "") {
        released ||= before.trim() !== ""
        yield { type: "text-delta", text: before }
      }
      holding = true
      held = pending.slice(at)
      return
    }
    const keep = partialSuffix(pending, XML_TRIGGERS)
    const out = keep ? pending.slice(0, pending.length - keep) : pending
    if (out !== "") {
      released ||= out.trim() !== ""
      yield { type: "text-delta", text: out }
    }
    held = keep ? pending.slice(pending.length - keep) : ""
  }

  function* feed(chunk: string): Generator<StreamEvent> {
    if (!thinkTags) {
      yield* emitText(chunk)
      return
    }
    tagBuffer += chunk
    while (tagBuffer !== "") {
      if (inThink) {
        const end = tagBuffer.indexOf(CLOSE)
        if (end >= 0) {
          const body = tagBuffer.slice(0, end)
          if (body !== "") yield { type: "reasoning-delta", text: body }
          yield { type: "reasoning-end" }
          tagBuffer = tagBuffer.slice(end + CLOSE.length).replace(/^\n+/, "")
          inThink = false
          continue
        }
        const keep = partialSuffix(tagBuffer, [CLOSE])
        const body = tagBuffer.slice(0, tagBuffer.length - keep)
        if (body !== "") yield { type: "reasoning-delta", text: body }
        tagBuffer = tagBuffer.slice(tagBuffer.length - keep)
        return
      }
      const start = tagBuffer.indexOf(OPEN)
      if (start >= 0) {
        yield* emitText(tagBuffer.slice(0, start))
        tagBuffer = tagBuffer.slice(start + OPEN.length)
        inThink = true
        thinkSeen = true
        continue
      }
      // a template that opens the thought itself leaves only the closing tag in the output
      const close = tagBuffer.indexOf(CLOSE)
      if (close >= 0 && !thinkSeen && !released) {
        const body = tagBuffer.slice(0, close)
        if (body.trim() !== "") yield { type: "reasoning-delta", text: body }
        yield { type: "reasoning-end" }
        thinkSeen = true
        tagBuffer = tagBuffer.slice(close + CLOSE.length).replace(/^\n+/, "")
        continue
      }
      const keep = partialSuffix(tagBuffer, [OPEN, CLOSE])
      yield* emitText(tagBuffer.slice(0, tagBuffer.length - keep))
      tagBuffer = tagBuffer.slice(tagBuffer.length - keep)
      return
    }
  }

  for await (const event of source) {
    if (event.type === "text-delta") {
      yield* feed(event.text)
      continue
    }
    if (event.type === "tool-call") structured++
    if (event.type !== "finish") {
      yield event
      continue
    }

    // end of stream: settle anything still buffered
    if (tagBuffer !== "") {
      const rest = tagBuffer
      tagBuffer = ""
      if (inThink) {
        yield { type: "reasoning-delta", text: rest }
        yield { type: "reasoning-end" }
      } else yield* emitText(rest)
    }
    let finish = event
    if (held !== "") {
      const text = held
      held = ""
      const parsed = structured === 0 ? parseTextToolCalls(text, opts.toolNames) : undefined
      if (parsed) {
        if (parsed.rest !== "") yield { type: "text-delta", text: parsed.rest }
        for (const call of parsed.calls) {
          const id = `call_t${nextCall++}_${Date.now().toString(36)}`
          yield { type: "tool-input-start", id, name: call.name }
          yield { type: "tool-call", id, name: call.name, input: call.args, viaText: true }
        }
        if (finish.reason === "stop" || finish.reason === "unknown") finish = { ...finish, reason: "tool-calls" }
      } else {
        yield { type: "text-delta", text }
      }
    }
    yield finish
  }
}
