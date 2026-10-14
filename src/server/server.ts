import { timingSafeEqual } from "node:crypto"
import { VERSION } from "../global"
import { project } from "../project"
import { subscribe } from "../util/bus"
import { redactDeep, registerSecret } from "../util/redact"
import { listFiles } from "../util/walk"
import { getConfig } from "../config/config"
import { listAgents } from "../agent/agent"
import { allProviders, defaultModel } from "../provider/provider"
import { listCommands, runCommand } from "../command/command"
import { pendingPermissions, replyPermission, type PermissionReply } from "../permission/permission"
import { createSession, deleteSession, getSession, listSessions, updateSession } from "../session/store"
import { busySessions, BusyError, cancel, compactSession, isBusy, prompt, shell } from "../session/prompt"
import { revert, unrevert, visibleMessages } from "../session/revert"
import { exportMarkdown, forkSession } from "../session/export"
import { fuzzyFilter } from "../tui/fuzzy"

export interface ServerOptions {
  port?: number
  hostname?: string
  /** When set, every request must carry it as the HTTP Basic password. */
  password?: string
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

const json = (data: unknown, status = 200) => Response.json(redactDeep(data), { status })

async function body(req: Request): Promise<Record<string, any>> {
  if (req.method === "GET" || req.method === "DELETE") return {}
  const reader = req.body?.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.length
        if (size > 1024 * 1024) { await reader.cancel(); throw new HttpError(413, "Request body is too large") }
        chunks.push(value)
      }
    } finally { reader.releaseLock() }
  }
  const text = Buffer.concat(chunks).toString("utf8")
  if (text.trim() === "") return {}
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error()
    return parsed
  } catch {
    throw new HttpError(400, "Request body must be a JSON object")
  }
}

function authorized(req: Request, password: string | undefined): boolean {
  if (!password) return true
  const header = req.headers.get("authorization") ?? ""
  if (!header.toLowerCase().startsWith("basic ")) return false
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8")
  const given = Buffer.from(decoded.slice(decoded.indexOf(":") + 1))
  const expected = Buffer.from(password)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

async function requireSession(id: string) {
  const session = await getSession(id)
  if (!session) throw new HttpError(404, `Session not found: ${id}`)
  return session
}

function modelOf(input: any): { providerID: string; modelID: string } | undefined {
  if (!input) return undefined
  if (typeof input === "string") {
    const slash = input.indexOf("/")
    if (slash === -1) throw new HttpError(400, 'model must look like "provider/model"')
    return { providerID: input.slice(0, slash), modelID: input.slice(slash + 1) }
  }
  if (typeof input.providerID === "string" && typeof input.modelID === "string") return { providerID: input.providerID, modelID: input.modelID }
  throw new HttpError(400, "model must be a string or { providerID, modelID }")
}

/** Server-sent events: every bus event as `data: {type, properties}`. */
function events(req: Request): Response {
  const encoder = new TextEncoder()
  let cleanup = () => {}
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (payload: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
        } catch {
          cleanup()
        }
      }
      send({ type: "server.connected", properties: { version: VERSION } })
      const off = subscribe("*", (event) => send(redactDeep({ type: event.type, properties: slim(event) })))
      // Comment lines keep idle connections from being closed by proxies.
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"))
        } catch {
          cleanup()
        }
      }, 15_000)
      cleanup = () => {
        off()
        clearInterval(heartbeat)
      }
      req.signal.addEventListener("abort", () => {
        cleanup()
        try {
          controller.close()
        } catch {}
      })
    },
    cancel() {
      cleanup()
    },
  })
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } })
}

/** Provider-native replay data is large and of no use to clients. */
function slim(event: { type: string; properties: any }) {
  if (event.type === "message.updated" && event.properties?.message?.raw !== undefined) {
    const { raw: _raw, ...message } = event.properties.message
    return { ...event.properties, message }
  }
  return event.properties
}

const withoutRaw = (message: any) => {
  const { raw: _raw, ...rest } = message
  return rest
}

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent)
  const method = req.method
  const is = (m: string, ...pattern: string[]) => method === m && parts.length === pattern.length && pattern.every((p, i) => p === "*" || p === parts[i])

  if (is("GET", "health") || (method === "GET" && parts.length === 0)) return json({ name: "deberopa", version: VERSION, ok: true })
  if (is("GET", "event")) return events(req)
  if (is("GET", "project")) return json(project())
  if (is("GET", "config")) return json(redactDeep(await getConfig()))
  if (is("GET", "agent")) return json(Object.values(await listAgents()))
  if (is("GET", "command")) return json(Object.values(await listCommands()))
  if (is("GET", "provider")) {
    const providers = Object.values(await allProviders()).map(({ apiKey: _key, headers: _headers, ...rest }) => ({ ...rest, connected: rest.source !== "none" }))
    return json({ providers, default: await defaultModel() })
  }
  if (is("GET", "find", "file")) {
    const query = url.searchParams.get("query") ?? ""
    const files = await listFiles({ cwd: project().directory, limit: 20_000 })
    return json(fuzzyFilter(query, files, (f) => f, Number(url.searchParams.get("limit") ?? 50)))
  }
  if (is("GET", "permission")) return json(pendingPermissions())
  if (is("POST", "permission", "*")) {
    const input = await body(req)
    const reply = input.reply as PermissionReply
    if (!["once", "always", "reject"].includes(reply)) throw new HttpError(400, 'reply must be "once", "always" or "reject"')
    if (!replyPermission(parts[1]!, reply, typeof input.message === "string" ? input.message : undefined)) throw new HttpError(404, "No pending permission with that id")
    return json(true)
  }

  if (is("GET", "session")) return json(await listSessions({ includeChildren: url.searchParams.get("children") === "true" }))
  if (is("GET", "session", "status")) return json(busySessions())
  if (is("POST", "session")) {
    const input = await body(req)
    return json(await createSession({ title: typeof input.title === "string" ? input.title : undefined, parentID: typeof input.parentID === "string" ? input.parentID : undefined }), 201)
  }

  if (parts[0] === "session" && parts[1]) {
    const id = parts[1]
    const session = await requireSession(id)
    if (is("GET", "session", "*")) return json({ ...session, busy: isBusy(id) })
    if (is("PATCH", "session", "*")) {
      const input = await body(req)
      if (typeof input.title !== "string" || input.title.trim() === "") throw new HttpError(400, "title is required")
      return json(await updateSession(id, (s) => (s.title = input.title.trim())))
    }
    if (is("DELETE", "session", "*")) {
      cancel(id)
      await deleteSession(id)
      return json(true)
    }
    if (is("GET", "session", "*", "message")) return json((await visibleMessages(id)).map(withoutRaw))
    if (is("GET", "session", "*", "export")) {
      return new Response(await exportMarkdown(id, { tools: true }), { headers: { "content-type": "text/markdown; charset=utf-8" } })
    }
    if (is("POST", "session", "*", "message") || is("POST", "session", "*", "prompt_async")) {
      const input = await body(req)
      if (typeof input.text !== "string" || input.text.trim() === "") throw new HttpError(400, "text is required")
      if (isBusy(id)) throw new HttpError(409, "The session is busy")
      const run = prompt({ sessionID: id, text: input.text, agent: typeof input.agent === "string" ? input.agent : undefined, model: modelOf(input.model) })
      if (parts[2] === "prompt_async") {
        run.catch(() => {}) // failures are reported on the event stream
        return json({ accepted: true }, 202)
      }
      const message = await run
      return json(message ? withoutRaw(message) : null)
    }
    if (is("POST", "session", "*", "command")) {
      const input = await body(req)
      if (typeof input.name !== "string") throw new HttpError(400, "name is required")
      const message = await runCommand({ sessionID: id, name: input.name, arguments: typeof input.arguments === "string" ? input.arguments : "", agent: input.agent, model: modelOf(input.model) })
      return json(message ? withoutRaw(message) : null)
    }
    if (is("POST", "session", "*", "shell")) {
      const input = await body(req)
      if (typeof input.command !== "string" || input.command.trim() === "") throw new HttpError(400, "command is required")
      return json(await shell({ sessionID: id, command: input.command }))
    }
    if (is("POST", "session", "*", "abort")) return json(cancel(id))
    if (is("POST", "session", "*", "compact")) {
      const summary = await compactSession(id)
      return json(summary ? withoutRaw(summary) : null)
    }
    if (is("POST", "session", "*", "revert")) {
      const input = await body(req)
      if (typeof input.messageID !== "string") throw new HttpError(400, "messageID is required")
      return json(await revert(id, input.messageID))
    }
    if (is("POST", "session", "*", "unrevert")) return json(await unrevert(id))
    if (is("POST", "session", "*", "fork")) {
      const input = await body(req)
      return json(await forkSession(id, typeof input.messageID === "string" ? input.messageID : undefined), 201)
    }
  }
  throw new HttpError(404, `No route for ${method} ${url.pathname}`)
}

export function startServer(options: ServerOptions = {}) {
  const password = options.password ?? process.env.DEBEROPA_SERVER_PASSWORD
  const hostname = options.hostname ?? "127.0.0.1"
  if (!["127.0.0.1", "localhost", "::1"].includes(hostname) && !password) throw new Error("A non-local server requires DEBEROPA_SERVER_PASSWORD.")
  registerSecret(password)
  return Bun.serve({
    port: options.port ?? 4096,
    hostname,
    idleTimeout: 0,
    async fetch(req) {
      const requestURL = new URL(req.url)
      if (["127.0.0.1", "localhost", "::1"].includes(hostname) && !["127.0.0.1", "localhost", "::1", "[::1]"].includes(requestURL.hostname)) return new Response("Forbidden host", { status: 403 })
      const origin = req.headers.get("origin")
      if (origin && origin !== requestURL.origin) return new Response("Forbidden origin", { status: 403 })
      if (!authorized(req, password)) {
        return new Response("Unauthorized", { status: 401, headers: { "www-authenticate": 'Basic realm="deberopa"' } })
      }
      try {
        return await route(req)
      } catch (err) {
        if (err instanceof HttpError) return json({ error: err.message }, err.status)
        if (err instanceof BusyError) return json({ error: "The session is busy" }, 409)
        const name = err instanceof Error ? err.name : "Error"
        const status = name === "ModelNotFoundError" || name === "NoModelError" || name === "CommandNotFoundError" || name === "RevertError" ? 400 : 500
        return json(redactDeep({ error: err instanceof Error ? err.message : String(err), name }), status)
      }
    },
  })
}
