import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { NAME, VERSION } from "../global"
import { createLogger } from "../util/log"
import { launchSpec } from "../util/shell"

const log = createLogger("mcp")

const PROTOCOL_VERSION = "2025-06-18"
const REQUEST_TIMEOUT = 30000
const TOOL_CALL_TIMEOUT = 300000

export type McpServerConfig =
  | { type: "local"; command: string[]; environment?: Record<string, string>; cwd?: string; enabled?: boolean; timeout?: number }
  | { type: "remote"; url: string; headers?: Record<string, string>; enabled?: boolean; timeout?: number }

export interface McpTool {
  name: string
  description?: string
  inputSchema: Record<string, any>
}

export interface McpCallResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string; [k: string]: unknown }>
  isError?: boolean
}

export interface McpClient {
  readonly name: string
  readonly serverInfo?: { name?: string; version?: string }
  listTools(): Promise<McpTool[]>
  callTool(name: string, args: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<McpCallResult>
  listPrompts(): Promise<Array<{ name: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }> }>>
  getPrompt(name: string, args?: Record<string, string>): Promise<{ messages: Array<{ role: string; content: { type: string; text?: string } }> }>
  close(): Promise<void>
}

export class McpError extends Error {
  code?: number

  constructor(message: string, code?: number) {
    super(message)
    this.name = "McpError"
    this.code = code
  }
}

type McpPrompt = Awaited<ReturnType<McpClient["listPrompts"]>>[number]
type McpPromptResult = Awaited<ReturnType<McpClient["getPrompt"]>>
type StdioConfig = Extract<McpServerConfig, { type: "local" }>
type HttpConfig = Extract<McpServerConfig, { type: "remote" }>
type SSEEvent = { event: string; data: string; id?: string }

interface RpcMessage {
  jsonrpc?: "2.0"
  id?: number | string | null
  method?: string
  params?: unknown
  result?: any
  error?: { code: number; message: string; data?: unknown }
}

/** A transport only moves messages; JsonRpc owns ids, pending requests and timeouts. */
interface Wire {
  send(msg: RpcMessage, signal?: AbortSignal): Promise<void>
  close(): Promise<void>
  setProtocolVersion?(version: string): void
}

/** Splits streamed text into complete lines, keeping the unfinished tail for the next chunk. */
class LineBuffer {
  private rest = ""

  push(chunk: string): string[] {
    const parts = (this.rest + chunk).split("\n")
    this.rest = parts.pop() ?? ""
    return parts
  }
}

class JsonRpc {
  private nextId = 1
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(err: McpError): void }>()
  private wire?: Wire
  private failure?: McpError

  constructor(readonly name: string) {}

  attach(wire: Wire) {
    this.wire = wire
  }

  isPending(id: number): boolean {
    return this.pending.has(id)
  }

  /** Parses one JSON text (a message or a batch). Non-JSON text is ignored. */
  receiveRaw(text: string) {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return
    }
    for (const msg of Array.isArray(parsed) ? parsed : [parsed]) {
      if (msg && typeof msg === "object") this.receive(msg as RpcMessage)
    }
  }

  private receive(msg: RpcMessage) {
    if (msg.method !== undefined) {
      if (msg.id !== undefined && msg.id !== null) this.answerServerRequest(msg)
      return
    }
    if (typeof msg.id !== "number") return
    const p = this.pending.get(msg.id)
    if (!p) return
    if (msg.error) p.reject(new McpError(msg.error.message, msg.error.code))
    else p.resolve(msg.result)
  }

  private answerServerRequest(req: RpcMessage) {
    const reply: RpcMessage =
      req.method === "ping"
        ? { jsonrpc: "2.0", id: req.id, result: {} }
        : { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `Method not found: ${req.method}` } }
    this.wire?.send(reply).catch(() => {})
  }

  request(method: string, params: unknown, timeout: number, signal?: AbortSignal): Promise<any> {
    if (this.failure) return Promise.reject(this.failure)
    if (!this.wire) return Promise.reject(new McpError(`MCP server "${this.name}" is not connected`))
    if (signal?.aborted) return Promise.reject(new McpError(`MCP request "${method}" was aborted`))
    const wire = this.wire
    const id = this.nextId++
    const controller = new AbortController()
    return new Promise((resolve, reject) => {
      const finish = (err?: McpError, value?: unknown) => {
        if (!this.pending.delete(id)) return
        clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
        controller.abort()
        if (err) reject(err)
        else resolve(value)
      }
      const timer = setTimeout(
        () => finish(new McpError(`MCP request "${method}" to "${this.name}" timed out after ${timeout} ms`)),
        timeout,
      )
      const onAbort = () => {
        this.notify("notifications/cancelled", { requestId: id, reason: "aborted by client" }).catch(() => {})
        finish(new McpError(`MCP request "${method}" to "${this.name}" was aborted`))
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      this.pending.set(id, { resolve: (value) => finish(undefined, value), reject: (err) => finish(err) })
      wire.send({ jsonrpc: "2.0", id, method, params }, controller.signal).catch((err: unknown) => finish(this.toError(method, err)))
    })
  }

  notify(method: string, params?: unknown): Promise<void> {
    if (this.failure) return Promise.reject(this.failure)
    return this.wire ? this.wire.send({ jsonrpc: "2.0", method, params }) : Promise.resolve()
  }

  /** Rejects every pending request and makes all later calls fail with the same error. */
  failAll(err: McpError) {
    this.failure ??= err
    for (const p of [...this.pending.values()]) p.reject(err)
  }

  async close(): Promise<void> {
    this.failAll(new McpError(`MCP server "${this.name}" connection closed`))
    await this.wire?.close()
  }

  private toError(method: string, err: unknown): McpError {
    if (err instanceof McpError) return err
    const detail = err instanceof Error ? err.message : String(err)
    return new McpError(`MCP request "${method}" to "${this.name}" failed: ${detail}`)
  }
}

class StdioWire implements Wire {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly stdoutLines = new LineBuffer()
  private readonly stderrLines = new LineBuffer()
  private stderrTail = ""
  private failed = false
  private closing = false
  private done = false

  constructor(
    private readonly rpc: JsonRpc,
    private readonly name: string,
    config: StdioConfig,
  ) {
    const [command, ...args] = config.command
    if (!command) throw new McpError(`MCP server "${name}" has an empty command`)
    const launch = launchSpec(config.command)
    try {
      this.child = spawn(launch.file, launch.args, {
        env: { ...process.env, ...config.environment },
        cwd: config.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        windowsVerbatimArguments: launch.verbatim,
      })
    } catch (err) {
      throw new McpError(`MCP server "${name}" could not be started (${command}): ${err instanceof Error ? err.message : String(err)}`)
    }

    // A write to a dead process fails here too; the exit or error event reports the real cause.
    this.child.stdin.on("error", () => {})
    this.child.stdout.setEncoding("utf8")
    this.child.stdout.on("data", (chunk: string) => {
      for (const line of this.stdoutLines.push(chunk)) this.rpc.receiveRaw(line)
    })
    this.child.stderr.setEncoding("utf8")
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2000)
      for (const line of this.stderrLines.push(chunk)) {
        if (line.trim()) log.debug(`${name}: ${line.trimEnd()}`)
      }
    })
    this.child.on("error", (err) => {
      if (this.child.pid === undefined) this.done = true
      this.fail(`could not run "${command}": ${err.message}`)
    })
    this.child.on("exit", (code, signal) => {
      this.done = true
      this.fail(`exited unexpectedly (code ${code}, signal ${signal})`)
    })
  }

  send(msg: RpcMessage): Promise<void> {
    if (this.failed || this.closing) return Promise.reject(new McpError(`MCP server "${this.name}" is not running`))
    this.child.stdin.write(JSON.stringify(msg) + "\n")
    return Promise.resolve()
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    this.child.stdin.end()
    if (this.done) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill()
        resolve()
      }, 2000)
      this.child.once("exit", () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  private fail(reason: string) {
    if (this.failed || this.closing) return
    this.failed = true
    const stderr = this.stderrTail.slice(-500).trim()
    this.rpc.failAll(new McpError(`MCP server "${this.name}" ${reason}${stderr ? `\nstderr: ${stderr}` : ""}`))
  }
}

class HttpWire implements Wire {
  private sessionId?: string
  private protocolVersion?: string
  private legacyEndpoint?: string
  private legacyStream?: AbortController
  private endpointTimer?: ReturnType<typeof setTimeout>
  private closed = false

  constructor(
    private readonly rpc: JsonRpc,
    private readonly name: string,
    private readonly config: HttpConfig,
  ) {}

  setProtocolVersion(version: string) {
    this.protocolVersion = version
  }

  private headers(extra: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { ...this.config.headers, ...extra }
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId
    if (this.protocolVersion) headers["MCP-Protocol-Version"] = this.protocolVersion
    return headers
  }

  async send(msg: RpcMessage, signal?: AbortSignal): Promise<void> {
    if (this.closed) throw new McpError(`MCP server "${this.name}" is closed`)
    const body = JSON.stringify(msg)
    const headers = this.headers({ "Content-Type": "application/json", Accept: "application/json, text/event-stream" })

    if (this.legacyEndpoint) {
      const res = await fetch(this.legacyEndpoint, { method: "POST", headers, body, signal, redirect: "error" })
      if (!res.ok) throw await this.httpError(res)
      // The reply for a legacy POST arrives on the event stream, not in this response.
      await res.body?.cancel().catch(() => {})
      return
    }

    const res = await fetch(this.config.url, { method: "POST", headers, body, signal, redirect: "error" })
    const sessionId = res.headers.get("mcp-session-id")
    if (sessionId) this.sessionId = sessionId

    // Servers that only speak the old HTTP+SSE transport reject the Streamable HTTP POST.
    if (msg.method === "initialize" && (res.status === 404 || res.status === 405)) {
      await res.body?.cancel().catch(() => {})
      this.legacyEndpoint = await this.openLegacyStream()
      return this.send(msg, signal)
    }
    if (!res.ok) throw await this.httpError(res)
    if (res.status === 202) {
      await res.body?.cancel().catch(() => {})
      return
    }

    if ((res.headers.get("content-type") ?? "").includes("text/event-stream") && res.body) {
      // Stop once our own response has arrived; the server may keep the stream open.
      const requestId = msg.method !== undefined && typeof msg.id === "number" ? msg.id : undefined
      await readSse(
        res.body,
        (ev) => {
          if (ev.event === "message") this.rpc.receiveRaw(ev.data)
        },
        requestId === undefined ? undefined : () => !this.rpc.isPending(requestId),
      )
      return
    }
    const text = await res.text()
    if (text) this.rpc.receiveRaw(text)
  }

  private async openLegacyStream(): Promise<string> {
    const abort = new AbortController()
    this.legacyStream = abort
    const res = await fetch(this.config.url, { headers: this.headers({ Accept: "text/event-stream" }), signal: abort.signal, redirect: "error" })
    if (!res.ok || !res.body) throw await this.httpError(res)
    const body = res.body
    return new Promise<string>((resolve, reject) => {
      const timeout = this.config.timeout ?? REQUEST_TIMEOUT
      this.endpointTimer = setTimeout(
        () => reject(new McpError(`MCP server "${this.name}" did not announce an endpoint within ${timeout} ms`)),
        timeout,
      )
      readSse(body, (ev) => {
        if (ev.event === "endpoint") {
          clearTimeout(this.endpointTimer)
          const endpoint = new URL(ev.data.trim(), this.config.url)
          if (endpoint.origin !== new URL(this.config.url).origin) {
            reject(new McpError("A legacy MCP endpoint must have the same origin as its server"))
            abort.abort()
            return
          }
          resolve(endpoint.toString())
        } else if (ev.event === "message") {
          this.rpc.receiveRaw(ev.data)
        }
      })
        .catch(() => {})
        .finally(() => {
          clearTimeout(this.endpointTimer)
          if (this.closed) return
          const err = new McpError(`MCP server "${this.name}" closed its event stream`)
          reject(err)
          this.rpc.failAll(err)
        })
    })
  }

  private async httpError(res: Response): Promise<McpError> {
    const detail = (await res.text().catch(() => "")).trim().slice(0, 200)
    if (res.status === 401 || res.status === 403) {
      return new McpError(
        `MCP server "${this.name}" requires authentication (HTTP ${res.status}). Add an Authorization header under mcp.${this.name}.headers in your config.`,
        res.status,
      )
    }
    return new McpError(`MCP server "${this.name}" returned HTTP ${res.status}${detail ? `: ${detail}` : ""}`, res.status)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.endpointTimer)
    this.legacyStream?.abort()
    if (this.sessionId) {
      await fetch(this.config.url, { method: "DELETE", headers: this.headers({}), signal: AbortSignal.timeout(5000), redirect: "error" }).catch(() => {})
    }
  }
}

/** Parses an SSE byte stream fed in arbitrary chunks. Handles CR, LF and CRLF line endings. */
export function createSSEParser(onEvent: (event: SSEEvent) => void): { feed(chunk: string): void } {
  let buf = ""
  let eventName = ""
  let eventId: string | undefined
  let data: string[] = []

  const dispatch = () => {
    if (data.length > 0) onEvent({ event: eventName || "message", data: data.join("\n"), id: eventId })
    eventName = ""
    eventId = undefined
    data = []
  }
  const handleLine = (line: string) => {
    if (line === "") return dispatch()
    if (line.startsWith(":")) return
    const colon = line.indexOf(":")
    const field = colon === -1 ? line : line.slice(0, colon)
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "")
    if (field === "event") eventName = value
    else if (field === "data") data.push(value)
    else if (field === "id") eventId = value
  }

  return {
    feed(chunk: string) {
      buf += chunk
      let start = 0
      for (let i = 0; i < buf.length; i++) {
        const c = buf[i]
        if (c !== "\n" && c !== "\r") continue
        // A trailing CR may be the first half of a CRLF split across chunks, so wait for more input.
        if (c === "\r" && i === buf.length - 1) break
        handleLine(buf.slice(start, i))
        if (c === "\r" && buf[i + 1] === "\n") i++
        start = i + 1
      }
      buf = buf.slice(start)
    },
  }
}

async function readSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: SSEEvent) => void,
  isFinished?: () => boolean,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const parser = createSSEParser(onEvent)
  while (true) {
    const next = await reader.read()
    if (next.done) break
    parser.feed(decoder.decode(next.value, { stream: true }))
    if (isFinished?.()) {
      await reader.cancel().catch(() => {})
      return
    }
  }
  parser.feed(decoder.decode())
}

class Client implements McpClient {
  readonly serverInfo?: { name?: string; version?: string }
  private readonly capabilities: Record<string, unknown>

  constructor(
    readonly name: string,
    private readonly rpc: JsonRpc,
    private readonly timeout: number | undefined,
    init: any,
  ) {
    this.serverInfo = init?.serverInfo
    this.capabilities = init?.capabilities ?? {}
  }

  listTools(): Promise<McpTool[]> {
    return this.paginate<McpTool>("tools/list", "tools")
  }

  async callTool(name: string, args: Record<string, unknown>, opts: { signal?: AbortSignal } = {}): Promise<McpCallResult> {
    const res: any = await this.rpc.request("tools/call", { name, arguments: args }, this.timeout ?? TOOL_CALL_TIMEOUT, opts.signal)
    return { content: res?.content ?? [], isError: res?.isError }
  }

  listPrompts(): Promise<McpPrompt[]> {
    if (!this.capabilities.prompts) return Promise.resolve([])
    return this.paginate<McpPrompt>("prompts/list", "prompts")
  }

  getPrompt(name: string, args?: Record<string, string>): Promise<McpPromptResult> {
    return this.rpc.request("prompts/get", { name, arguments: args }, this.timeout ?? REQUEST_TIMEOUT)
  }

  close(): Promise<void> {
    return this.rpc.close()
  }

  private async paginate<T>(method: string, key: "tools" | "prompts"): Promise<T[]> {
    const items: T[] = []
    const seen = new Set<string>()
    let cursor: string | undefined
    do {
      const page: any = await this.rpc.request(method, cursor ? { cursor } : {}, this.timeout ?? REQUEST_TIMEOUT)
      items.push(...(page?.[key] ?? []))
      const next: unknown = page?.nextCursor
      cursor = typeof next === "string" && next && !seen.has(next) ? next : undefined
      if (cursor) seen.add(cursor)
    } while (cursor)
    return items
  }
}

export async function connectMcp(name: string, config: McpServerConfig): Promise<McpClient> {
  const rpc = new JsonRpc(name)
  const wire: Wire = config.type === "local" ? new StdioWire(rpc, name, config) : new HttpWire(rpc, name, config)
  rpc.attach(wire)
  try {
    const init = await rpc.request(
      "initialize",
      { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: NAME, version: VERSION } },
      config.timeout ?? REQUEST_TIMEOUT,
    )
    wire.setProtocolVersion?.(typeof init?.protocolVersion === "string" ? init.protocolVersion : PROTOCOL_VERSION)
    await rpc.notify("notifications/initialized")
    return new Client(name, rpc, config.timeout, init)
  } catch (err) {
    await rpc.close()
    throw err
  }
}
