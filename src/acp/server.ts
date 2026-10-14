import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Readable, Writable } from "node:stream"
import { VERSION } from "../global"
import { project, initProject } from "../project"
import { subscribe } from "../util/bus"
import { createLogger } from "../util/log"
import { redact } from "../util/redact"
import { replyPermission, rejectPending, type PendingPermission } from "../permission/permission"
import { createSession, getMessages, getSession } from "../session/store"
import { cancel, isBusy, prompt as runPrompt } from "../session/prompt"
import { addMcpServer } from "../mcp"
import { describeTool } from "../tool/describe"
import { primaryAgents } from "../agent/agent"
import { parseModelRef } from "../provider/provider"
import type { AssistantMessage, Message, Part, ToolPart } from "../session/message"

const log = createLogger("acp")

/** Agent Client Protocol (https://agentclientprotocol.com): JSON-RPC 2.0, one JSON object per line. */
const PROTOCOL_VERSION = 1

class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message)
  }
}
const invalid = (message: string) => new RpcError(-32602, message)

type ToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "other"

function toolKind(tool: string): ToolKind {
  switch (tool) {
    case "read":
      return "read"
    case "edit":
    case "multiedit":
    case "write":
    case "patch":
      return "edit"
    case "glob":
    case "grep":
    case "list":
      return "search"
    case "bash":
      return "execute"
    case "webfetch":
    case "websearch":
      return "fetch"
    case "todowrite":
    case "todoread":
      return "think"
    default:
      return "other"
  }
}

const text = (t: string) => ({ type: "content", content: { type: "text", text: t } })

/** Convert ACP prompt content blocks into our prompt text and attachments. */
export function fromContentBlocks(blocks: any[]): { text: string; files: { mime: string; filename?: string; data: string }[] } {
  const parts: string[] = []
  const files: { mime: string; filename?: string; data: string }[] = []
  for (const block of blocks ?? []) {
    switch (block?.type) {
      case "text":
        if (typeof block.text === "string") parts.push(block.text)
        break
      case "image":
        if (typeof block.data === "string" && typeof block.mimeType === "string") files.push({ mime: block.mimeType, data: block.data })
        break
      case "resource_link": {
        // @path mentions are resolved to file contents by the prompt layer
        const file = toPath(block.uri)
        parts.push(file ? `@${file}` : `${block.name ?? block.uri}`)
        break
      }
      case "resource": {
        const r = block.resource ?? {}
        if (typeof r.text === "string") parts.push(`Contents of ${toPath(r.uri) ?? r.uri ?? "an attached resource"}:\n\`\`\`\n${r.text}\n\`\`\``)
        else if (typeof r.blob === "string" && typeof r.mimeType === "string" && r.mimeType.startsWith("image/")) files.push({ mime: r.mimeType, data: r.blob })
        break
      }
    }
  }
  return { text: parts.join("\n\n").trim(), files }
}

function toPath(uri: unknown): string | undefined {
  if (typeof uri !== "string") return undefined
  if (uri.startsWith("file://")) {
    try {
      return fileURLToPath(uri)
    } catch {
      // Windows rejects a file URL without a drive letter; the path part is still the best answer
      try {
        return decodeURIComponent(new URL(uri).pathname)
      } catch {
        return undefined
      }
    }
  }
  return path.isAbsolute(uri) ? uri : undefined
}

interface AcpSession {
  id: string
  /** Messages whose text is a compaction summary and must not be streamed as an answer. */
  summaries: Set<string>
  tools: Map<string, string>
  running?: AbortController
}

export interface AcpOptions {
  input: Readable
  output: Writable
  /** Directory used when the client does not send one. */
  directory?: string
}

/** Serve one client over the given streams until the input closes. */
export function serveAcp(options: AcpOptions): Promise<void> {
  const { input, output } = options
  const sessions = new Map<string, AcpSession>()
  const pendingResponses = new Map<number | string, { resolve(v: any): void; reject(e: Error): void }>()
  let nextRequestID = 1
  let initialized = false
  let clientCapabilities: Record<string, unknown> = {}

  const write = (message: unknown) => {
    output.write(JSON.stringify(message) + "\n")
  }
  const notify = (method: string, params: unknown) => write({ jsonrpc: "2.0", method, params })
  const request = <T>(method: string, params: unknown): Promise<T> =>
    new Promise((resolve, reject) => {
      const id = nextRequestID++
      pendingResponses.set(id, { resolve, reject })
      write({ jsonrpc: "2.0", id, method, params })
    })
  const update = (sessionId: string, u: Record<string, unknown>) => notify("session/update", { sessionId, update: u })

  const rootOf = async (sessionID: string): Promise<string> => {
    let current = sessionID
    for (let i = 0; i < 10; i++) {
      const info = await getSession(current)
      if (!info?.parentID) return current
      current = info.parentID
    }
    return current
  }

  // ---- bus → ACP updates -------------------------------------------------------------------

  const toolTitle = (part: ToolPart) => {
    const d = describeTool(part)
    return d.detail ? `${d.name}: ${d.detail}` : d.name
  }

  const sendToolState = (session: AcpSession, part: ToolPart) => {
    const state = part.state
    const known = session.tools.get(part.callID)
    const status = state.status === "pending" ? "pending" : state.status === "running" ? "in_progress" : state.status === "completed" ? "completed" : "failed"
    const input = (state.input ?? {}) as Record<string, any>
    const filePath = typeof input.filePath === "string" ? input.filePath : undefined
    const locations = filePath ? [{ path: path.isAbsolute(filePath) ? filePath : path.resolve(project().directory, filePath) }] : undefined

    if (!known) {
      session.tools.set(part.callID, status)
      update(session.id, {
        sessionUpdate: "tool_call",
        toolCallId: part.callID,
        title: toolTitle(part),
        kind: toolKind(part.tool),
        status,
        rawInput: input,
        ...(locations ? { locations } : {}),
      })
      if (status === "pending") return
    }
    if (known === status && status !== "completed" && status !== "failed") return
    if (known === "completed" || known === "failed") return
    session.tools.set(part.callID, status)

    const content: unknown[] = []
    if (state.status === "completed") {
      const diff = (state.metadata as any)?.diff
      if (typeof diff === "string" && diff.trim() !== "") content.push(text("```diff\n" + diff.trim() + "\n```"))
      else if (state.output.trim() !== "") content.push(text(state.output.length > 20_000 ? state.output.slice(0, 20_000) + "\n…" : state.output))
    } else if (state.status === "error") content.push(text(state.error))
    update(session.id, {
      sessionUpdate: "tool_call_update",
      toolCallId: part.callID,
      title: toolTitle(part),
      status,
      rawInput: input,
      ...(content.length ? { content } : {}),
      ...(locations ? { locations } : {}),
    })
  }

  const unsubscribers: (() => void)[] = []
  unsubscribers.push(
    subscribe<{ message: Message }>("message.updated", ({ properties }) => {
      const m = properties.message
      const s = sessions.get(m.sessionID)
      if (s && m.role === "assistant" && (m as AssistantMessage).summary) s.summaries.add(m.id)
    }),
    subscribe<{ sessionID: string; messageID: string; part: Part; delta?: string }>("message.part.updated", ({ properties }) => {
      const s = sessions.get(properties.sessionID)
      if (!s || s.summaries.has(properties.messageID)) return
      const { part, delta } = properties
      if (part.type === "text" && delta) update(s.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: delta } })
      else if (part.type === "reasoning" && delta) update(s.id, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: delta } })
      else if (part.type === "tool") sendToolState(s, part)
    }),
    subscribe<{ sessionID: string; todos: { content: string; status: string; priority: string }[] }>("todo.updated", ({ properties }) => {
      const s = sessions.get(properties.sessionID)
      if (!s) return
      update(s.id, {
        sessionUpdate: "plan",
        entries: properties.todos.map((t) => ({
          content: t.content,
          priority: t.priority === "high" || t.priority === "low" ? t.priority : "medium",
          status: t.status === "completed" ? "completed" : t.status === "in_progress" ? "in_progress" : "pending",
        })),
      })
    }),
    subscribe<PendingPermission>("permission.asked", ({ properties }) => {
      void (async () => {
        const root = await rootOf(properties.sessionID)
        const s = sessions.get(root)
        if (!s) return
        try {
          const response: any = await request("session/request_permission", {
            sessionId: s.id,
            toolCall: {
              toolCallId: `perm_${properties.id}`,
              title: properties.title,
              kind: toolKind(properties.permission),
              status: "pending",
              rawInput: redactDeepSafe(properties.metadata),
            },
            options: [
              { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
              { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
              { optionId: "reject_once", name: "Reject", kind: "reject_once" },
            ],
          })
          const outcome = response?.outcome
          const chosen = outcome?.outcome === "selected" ? outcome.optionId : undefined
          replyPermission(properties.id, chosen === "allow_always" ? "always" : chosen === "allow_once" ? "once" : "reject")
        } catch (err) {
          log.warn("permission request failed; rejecting", err)
          replyPermission(properties.id, "reject")
        }
      })()
    }),
  )

  // ---- methods ------------------------------------------------------------------------------

  const getSessionState = (params: any): AcpSession => {
    const id = params?.sessionId
    const s = typeof id === "string" ? sessions.get(id) : undefined
    if (!s) throw invalid(`Unknown session: ${String(id)}`)
    return s
  }

  async function modes(sessionID: string) {
    const primary = await primaryAgents()
    const stored = [...(await getMessages(sessionID))].reverse().find((m) => m.role === "user")
    const current = stored && "agent" in stored ? stored.agent : "build"
    return {
      currentModeId: primary.some((a) => a.name === current) ? current : (primary[0]?.name ?? "build"),
      availableModes: primary.map((a) => ({ id: a.name, name: a.name, description: a.description })),
    }
  }

  async function connectMcpServers(servers: any[] | undefined) {
    for (const server of servers ?? []) {
      if (!server || typeof server.name !== "string") continue
      const headersOf = (list: any[] | undefined) => Object.fromEntries((list ?? []).map((h: any) => [h.name, h.value]))
      try {
        if (server.type === "http" || server.type === "sse") {
          void addMcpServer(server.name, { type: "remote", url: server.url, headers: headersOf(server.headers) })
        } else if (typeof server.command === "string") {
          void addMcpServer(server.name, {
            type: "local",
            command: [server.command, ...(server.args ?? [])],
            environment: Object.fromEntries((server.env ?? []).map((e: any) => [e.name, e.value])),
          })
        }
      } catch (err) {
        log.warn(`mcp server ${server.name} could not be added`, err)
      }
    }
  }

  async function handle(method: string, params: any): Promise<unknown> {
    switch (method) {
      case "initialize": {
        initialized = true
        clientCapabilities = params?.clientCapabilities ?? {}
        const requested = Number(params?.protocolVersion)
        return {
          protocolVersion: Number.isInteger(requested) && requested >= 1 ? Math.min(requested, PROTOCOL_VERSION) : PROTOCOL_VERSION,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: true, audio: false, embeddedContext: true },
            mcpCapabilities: { http: true, sse: true },
          },
          authMethods: [],
          agentInfo: { name: "deberopa", title: "Deberopa", version: VERSION },
        }
      }
      case "authenticate":
        return {}
      case "session/new": {
        if (!initialized) throw new RpcError(-32002, "Call initialize first")
        const cwd = typeof params?.cwd === "string" && path.isAbsolute(params.cwd) ? params.cwd : (options.directory ?? process.cwd())
        const here = project()
        if (sessions.size > 0 && path.resolve(cwd) !== path.resolve(here.directory)) {
          throw invalid(`This agent instance works in ${here.directory}. Start another \`deberopa acp\` for ${cwd}.`)
        }
        if (sessions.size === 0) initProject(cwd)
        await connectMcpServers(params?.mcpServers)
        const info = await createSession({ directory: cwd })
        sessions.set(info.id, { id: info.id, summaries: new Set(), tools: new Map() })
        return { sessionId: info.id, modes: await modes(info.id) }
      }
      case "session/load": {
        const id = params?.sessionId
        const info = typeof id === "string" ? await getSession(id) : undefined
        if (!info) throw invalid(`Unknown session: ${String(id)}`)
        if (sessions.size === 0) initProject(info.directory)
        await connectMcpServers(params?.mcpServers)
        const state: AcpSession = { id: info.id, summaries: new Set(), tools: new Map() }
        sessions.set(info.id, state)
        // replay the conversation so the editor can show it
        for (const message of await getMessages(info.id)) {
          if (message.role === "assistant" && (message as AssistantMessage).summary) continue
          for (const part of message.parts) {
            if (part.type === "text" && !part.synthetic) {
              update(info.id, { sessionUpdate: message.role === "user" ? "user_message_chunk" : "agent_message_chunk", content: { type: "text", text: part.text } })
            } else if (part.type === "reasoning" && part.text) {
              update(info.id, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: part.text } })
            } else if (part.type === "tool") sendToolState(state, part)
          }
        }
        return { modes: await modes(info.id) }
      }
      case "session/set_mode": {
        const s = getSessionState(params)
        const agents = await primaryAgents()
        if (!agents.some((a) => a.name === params?.modeId)) throw invalid(`Unknown mode: ${String(params?.modeId)}`)
        ;(s as any).mode = params.modeId
        update(s.id, { sessionUpdate: "current_mode_update", currentModeId: params.modeId })
        return {}
      }
      case "session/prompt": {
        const s = getSessionState(params)
        if (s.running || isBusy(s.id)) throw invalid("This session is already working on a prompt")
        const { text: body, files } = fromContentBlocks(params?.prompt)
        if (body === "" && files.length === 0) throw invalid("The prompt is empty")
        s.running = new AbortController()
        let cancelled = false
        const stop = () => {
          cancelled = true
        }
        s.running.signal.addEventListener("abort", stop, { once: true })
        try {
          const message = await runPrompt({
            sessionID: s.id,
            text: body,
            files,
            agent: (s as any).mode,
            model: typeof params?._meta?.model === "string" ? parseModelRef(params._meta.model) : undefined,
          })
          if (cancelled || message?.error?.name === "Aborted") return { stopReason: "cancelled" }
          if (message?.error?.name === "Refusal") return { stopReason: "refusal" }
          if (message?.error) throw new RpcError(-32603, redact(message.error.message))
          if (message?.finish === "length") return { stopReason: "max_tokens" }
          return { stopReason: "end_turn" }
        } finally {
          s.running = undefined
        }
      }
      default:
        throw new RpcError(-32601, `Method not found: ${method}`)
    }
  }

  // ---- transport ----------------------------------------------------------------------------

  const dispatch = async (message: any) => {
    if (!message || typeof message !== "object") return
    // a response to something we asked the client
    if (message.method === undefined && message.id !== undefined) {
      const waiting = pendingResponses.get(message.id)
      if (!waiting) return
      pendingResponses.delete(message.id)
      if (message.error) waiting.reject(new Error(String(message.error.message ?? "request failed")))
      else waiting.resolve(message.result)
      return
    }
    const { id, method, params } = message
    if (typeof method !== "string") return
    if (id === undefined) {
      // notifications
      if (method === "session/cancel") {
        const s = typeof params?.sessionId === "string" ? sessions.get(params.sessionId) : undefined
        if (s) {
          s.running?.abort()
          cancel(s.id)
          rejectPending(s.id)
        }
      }
      return
    }
    try {
      const result = await handle(method, params)
      write({ jsonrpc: "2.0", id, result })
    } catch (err) {
      const code = err instanceof RpcError ? err.code : -32603
      write({ jsonrpc: "2.0", id, error: { code, message: redact(err instanceof Error ? err.message : String(err)) } })
    }
  }

  return new Promise<void>((resolve) => {
    let buffer = ""
    const inflight = new Set<Promise<void>>()
    const pump = (line: string) => {
      if (line.trim() === "") return
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })
        return
      }
      // requests run concurrently (a prompt must not block cancel or permission replies)
      const task: Promise<void> = dispatch(message)
        .catch((err) => log.error("dispatch failed", err))
        .finally(() => inflight.delete(task))
      inflight.add(task)
    }
    input.setEncoding?.("utf8")
    input.on("data", (chunk: string | Buffer) => {
      buffer += chunk.toString()
      let at: number
      while ((at = buffer.indexOf("\n")) !== -1) {
        pump(buffer.slice(0, at))
        buffer = buffer.slice(at + 1)
      }
    })
    let finished = false
    const finish = async () => {
      if (finished) return
      finished = true
      if (buffer.trim()) pump(buffer)
      // the client is gone: stop running prompts, but let quick requests (session/new, ...) answer
      for (const s of sessions.values()) {
        s.running?.abort()
        cancel(s.id)
      }
      await Promise.race([Promise.allSettled([...inflight]), new Promise((r) => setTimeout(r, 10_000).unref?.())])
      for (const off of unsubscribers) off()
      resolve()
    }
    input.on("end", () => void finish())
    input.on("close", () => void finish())
    void clientCapabilities
  })
}

function redactDeepSafe(value: unknown): unknown {
  try {
    return JSON.parse(redact(JSON.stringify(value ?? {})))
  } catch {
    return {}
  }
}
