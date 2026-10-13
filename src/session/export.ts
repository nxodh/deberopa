import { createID } from "../util/id"
import { redact } from "../util/redact"
import { VERSION } from "../global"
import { project } from "../project"
import { importSession, requireSession, createSession, addMessage, updateSession, flush } from "./store"
import { visibleMessages } from "./revert"
import type { AssistantMessage, Message, Part, SessionInfo, ToolPart } from "./message"

export interface SessionExport {
  format: "vedecaps-session"
  version: 1
  exportedBy: string
  info: SessionInfo
  messages: Message[]
}

export async function exportJSON(sessionID: string): Promise<SessionExport> {
  const info = await requireSession(sessionID)
  const messages = await visibleMessages(sessionID)
  const data: SessionExport = { format: "vedecaps-session", version: 1, exportedBy: `vedecaps ${VERSION}`, info: { ...info, revert: undefined }, messages }
  // Tool output can contain whatever was on screen (an `env` dump, a .env file): scrub key shapes.
  return JSON.parse(redact(JSON.stringify(data))) as SessionExport
}

function fence(text: string, lang = ""): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
  const ticks = "`".repeat(longest + 1)
  return `${ticks}${lang}\n${text.replace(/\n$/, "")}\n${ticks}`
}

function toolSummary(part: ToolPart): string {
  const input = (part.state.input ?? {}) as Record<string, unknown>
  switch (part.tool) {
    case "bash":
      return String(input.command ?? "")
    case "read":
    case "edit":
    case "write":
    case "multiedit":
      return String(input.filePath ?? "")
    case "glob":
    case "grep":
      return String(input.pattern ?? "")
    case "webfetch":
      return String(input.url ?? "")
    default:
      return JSON.stringify(input).slice(0, 200)
  }
}

function renderPart(part: Part, opts: { thinking: boolean; tools: boolean }): string | undefined {
  switch (part.type) {
    case "text":
      return part.synthetic ? undefined : part.text.trim()
    case "reasoning":
      return opts.thinking && part.text.trim() ? `<details>\n<summary>Thinking</summary>\n\n${part.text.trim()}\n\n</details>` : undefined
    case "file":
      return `_[attached file: ${part.filename ?? part.mime}]_`
    case "tool": {
      if (!opts.tools) return undefined
      const state = part.state
      const head = `**${part.tool}** \`${toolSummary(part).replace(/`/g, "'")}\``
      if (state.status === "completed") return `${head}\n\n${fence(state.output)}`
      if (state.status === "error") return `${head} (failed)\n\n${fence(state.error)}`
      return `${head} (not finished)`
    }
    default:
      return undefined
  }
}

export async function exportMarkdown(sessionID: string, opts: { thinking?: boolean; tools?: boolean } = {}): Promise<string> {
  const info = await requireSession(sessionID)
  const messages = await visibleMessages(sessionID)
  const lines = [`# ${info.title}`, "", `Session \`${info.id}\` · created ${new Date(info.time.created).toISOString()} · updated ${new Date(info.time.updated).toISOString()}`, ""]
  for (const message of messages) {
    const body = message.parts
      .map((p) => renderPart(p, { thinking: opts.thinking ?? false, tools: opts.tools ?? true }))
      .filter((x): x is string => !!x)
    if (body.length === 0) continue
    if (message.role === "user") lines.push("## User", "")
    else {
      const a = message as AssistantMessage
      lines.push(`## Assistant (${a.agent} · ${a.modelID})`, "")
    }
    lines.push(body.join("\n\n"), "")
  }
  return redact(lines.join("\n").trimEnd() + "\n")
}

export class ImportError extends Error {}

export function parseExport(text: string): SessionExport {
  let data: any
  try {
    data = JSON.parse(text)
  } catch {
    throw new ImportError("The file is not valid JSON.")
  }
  if (data?.format !== "vedecaps-session" || !data.info || !Array.isArray(data.messages)) {
    throw new ImportError("This is not a Vedecaps session export (expected the JSON written by `vedecaps export`).")
  }
  if (data.version !== 1) throw new ImportError("Unsupported session export version.")
  if (typeof data.info.title !== "string" || data.messages.some((m: any) =>
    !m || typeof m.id !== "string" || typeof m.agent !== "string" || !Number.isFinite(m.time?.created) ||
    !["user", "assistant"].includes(m.role) || !Array.isArray(m.parts) ||
    (m.role === "user" && (typeof m.model?.providerID !== "string" || typeof m.model?.modelID !== "string")) ||
    (m.role === "assistant" && (typeof m.providerID !== "string" || typeof m.modelID !== "string" ||
      ["input", "output", "cacheRead", "cacheWrite"].some((key) => !Number.isFinite(m.tokens?.[key]) || m.tokens[key] < 0))) ||
    m.parts.some((p: any) => !p || !["text", "reasoning", "file", "tool", "patch", "step-start"].includes(p.type) ||
      (["text", "reasoning"].includes(p.type) && typeof p.text !== "string") ||
      (p.type === "file" && (typeof p.mime !== "string" || typeof p.data !== "string")) ||
      (p.type === "tool" && (typeof p.tool !== "string" || typeof p.callID !== "string" || !["pending", "running", "completed", "error"].includes(p.state?.status) ||
        (p.state.status === "completed" && typeof p.state.output !== "string") || (p.state.status === "error" && typeof p.state.error !== "string")))
    )
  )) throw new ImportError("The session contains malformed messages.")
  return data as SessionExport
}

/** Import under a fresh session id so the same export can be imported twice. */
export async function importExport(data: SessionExport): Promise<SessionInfo> {
  data = parseExport(JSON.stringify(data))
  const id = createID("session")
  const idMap = new Map<string, string>()
  const messages = data.messages.map((m) => {
    const newID = createID("message")
    idMap.set(m.id, newID)
    const parts = m.parts.filter((p) => p.type !== "patch" && p.type !== "step-start")
      .map((p) => ({ ...p, id: createID("part") }))
    return { ...m, id: newID, sessionID: id, parts, ...(m.role === "assistant" ? { raw: undefined } : {}) } as Message
  })
  for (const m of messages) if (m.role === "assistant") m.parentID = idMap.get(m.parentID) ?? m.parentID
  const now = Date.now()
  const info: SessionInfo = {
    ...data.info,
    id,
    projectID: project().id,
    directory: project().directory,
    revert: undefined,
    parentID: undefined,
    time: { created: now, updated: now },
  }
  const stored = await importSession({ info, messages })
  await flush()
  return stored
}

/** Copy a conversation (up to, not including, `beforeMessageID` when given) into a new session. */
export async function forkSession(sessionID: string, beforeMessageID?: string): Promise<SessionInfo> {
  const info = await requireSession(sessionID)
  const messages = (await visibleMessages(sessionID)).filter((m) => !beforeMessageID || m.id < beforeMessageID)
  const fork = await createSession({ directory: info.directory, title: `${info.title.replace(/ \(fork\)$/, "")} (fork)` })
  const idMap = new Map<string, string>()
  for (const m of messages) {
    const copy = structuredClone(m) as Message
    const newID = createID("message")
    idMap.set(m.id, newID)
    copy.id = newID
    copy.sessionID = fork.id
    if (copy.role === "assistant") copy.parentID = idMap.get(copy.parentID) ?? copy.parentID
    await addMessage(copy)
  }
  await flush()
  await updateSession(fork.id, () => {})
  return fork
}
