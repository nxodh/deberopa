import path from "node:path"
import { timingSafeEqual } from "node:crypto"
import { VERSION } from "../global"
import { project } from "../project"
import { subscribe } from "../util/bus"
import { redactDeep, registerSecret } from "../util/redact"
import { listFiles } from "../util/walk"
import { getConfig, globalConfigFile } from "../config/config"
import { listAgents } from "../agent/agent"
import { allProviders, defaultModel } from "../provider/provider"
import { listCommands, runCommand } from "../command/command"
import { pendingPermissions, replyPermission, type PermissionReply } from "../permission/permission"
import { createSession, deleteSession, getSession, listSessions, updateSession } from "../session/store"
import { busySessions, BusyError, cancel, compactSession, isBusy, prompt, shell } from "../session/prompt"
import { revert, unrevert, visibleMessages } from "../session/revert"
import { mcpStatus } from "../mcp"
import { lspStatus } from "../lsp"
import { loadPlugins, pluginProblems } from "../plugin"
import { closeTerminal, listTerminals, openTerminal, resizeTerminal, writeTerminal } from "../pty/pty"
import { changedFiles, diffSince, revertFiles, snapshotStatus } from "../snapshot/snapshot"
import { exportMarkdown, forkSession } from "../session/export"
import { fuzzyFilter } from "../tui/fuzzy"
import { allCredentials, removeCredential, setCredential } from "../auth/auth"
import { resetProviders } from "../provider/provider"
import { isTrusted, trustedProjects, trustProject, untrustProject } from "../config/trust"
import { loadConfig, resetConfig } from "../config/config"
import { listSkills } from "../skill/skill"
import { usageStats } from "../session/stats"
import { detectLocalServers, lastDetectFailures } from "../provider/local"
import { addRemoteHost, checkRemote, listRemoteHosts, removeRemoteHost, scanNetwork } from "../provider/remote"
import { DEFAULT_PORTS, modelMode, probeSlots, pullOllamaModel, startHint, toolCheckModel, validPullName } from "../provider/localmode"
import { publish } from "../util/bus"

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

/** Model downloads in progress, so the same one is not started twice. */
const pulls = new Map<string, AbortController>()

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
    const providers = Object.values(await allProviders()).map(({ apiKey: _key, headers: _headers, ...rest }) => ({
      ...rest,
      // how Deberopa adapts to each model (compact prompt, tool calls), so a client can say so
      models: Object.fromEntries(Object.entries(rest.models).map(([id, model]) => [id, { ...model, mode: modelMode(rest, model) }])),
      connected: rest.source !== "none",
    }))
    return json({ providers, default: await defaultModel() })
  }
  if (is("GET", "find", "file")) {
    const query = url.searchParams.get("query") ?? ""
    const files = await listFiles({ cwd: project().directory, limit: 20_000 })
    return json(fuzzyFilter(query, files, (f) => f, Number(url.searchParams.get("limit") ?? 50)))
  }
  // Local model servers on this machine (Ollama, LM Studio, llama.cpp / Opereta, vLLM): what `deberopa debug local` finds.
  // The probe addresses are fixed on purpose: a caller must not be able to aim the local API key at another host.
  if (is("GET", "local")) {
    const servers = await detectLocalServers()
    return json({
      servers: servers.map((s) => ({ ...s, models: Object.values(s.models), hint: startHint(s.opereta ? "opereta" : s.id) })),
      failures: lastDetectFailures(),
      disabled: !!process.env.DEBEROPA_DISABLE_LOCAL_DETECT,
      // where to look and how to start each kind, for when nothing answers
      expected: DEFAULT_PORTS.map((p) => ({ ...p, hint: startHint(p.kind) })),
    })
  }
  // One request to the model that asks it to call a tool: can this model drive the agent? Generates a few tokens.
  if (is("POST", "local", "toolcheck")) {
    const input = await body(req)
    const ref = modelOf(input.model ?? (typeof input.provider === "string" && typeof input.modelID === "string" ? { providerID: input.provider, modelID: input.modelID } : undefined))
    if (!ref) throw new HttpError(400, 'model must look like "provider/model"')
    return json(await toolCheckModel(ref.providerID, ref.modelID))
  }
  // Busy and total slots of a llama.cpp / Opereta server, when it exposes them.
  if (is("GET", "local", "slots")) {
    const id = url.searchParams.get("provider") ?? ""
    const provider = (await allProviders())[id]
    if (!provider?.baseURL) throw new HttpError(404, `Unknown provider: ${id}`)
    return json({ provider: id, slots: (await probeSlots(provider.baseURL, provider.apiKey)) ?? null, configured: provider.maxConcurrency ?? null })
  }
  // Download a model into a local Ollama. Progress arrives on the event stream as "local.pull".
  if (is("POST", "local", "pull")) {
    const input = await body(req)
    const providerID = typeof input.provider === "string" ? input.provider : "ollama"
    if (!validPullName(input.model)) throw new HttpError(400, "model is required (for example qwen3:8b)")
    const key = providerID + "/" + input.model
    if (pulls.has(key)) throw new HttpError(409, "That model is already being downloaded")
    const provider = (await allProviders())[providerID]
    if (!provider || provider.protocol !== "ollama") throw new HttpError(404, `${providerID} is not an Ollama server`)
    const controller = new AbortController()
    pulls.set(key, controller)
    pullOllamaModel(providerID, input.model, (p) => publish("local.pull", { provider: providerID, ...p }), controller.signal)
      .catch((err) => publish("local.pull", { provider: providerID, model: input.model, status: "error", done: true, error: err instanceof Error ? err.message : String(err) }))
      .finally(() => pulls.delete(key))
    return json({ accepted: true, provider: providerID, model: input.model }, 202)
  }
  // Model servers on other computers. A saved host is a provider; its key stays in the credential store
  // and is used only for that host's address. Scanning happens only when a client asks, sends no key
  // and walks only private addresses.
  if (is("GET", "remote")) return json(await listRemoteHosts())
  if (is("POST", "remote")) {
    const input = await body(req)
    if (typeof input.name !== "string" || typeof input.url !== "string") throw new HttpError(400, "name and url are required")
    if (typeof input.key === "string") registerSecret(input.key)
    try {
      return json(await addRemoteHost({ name: input.name, url: input.url, key: typeof input.key === "string" ? input.key : undefined, ca: typeof input.ca === "string" ? input.ca : undefined }), 201)
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err))
    }
  }
  if (is("POST", "remote", "check")) {
    const input = await body(req)
    if (typeof input.key === "string") registerSecret(input.key)
    if (typeof input.id === "string") {
      const host = (await listRemoteHosts()).find((h) => h.id === input.id)
      const info = (await allProviders())[input.id]
      if (!host || !info) throw new HttpError(404, `No saved host named ${input.id}`)
      return json(await checkRemote(host.url, { key: info.apiKey, tls: info.tls, providerID: host.id }))
    }
    // an address that is not saved: only a key given in this request goes with it
    if (typeof input.url !== "string") throw new HttpError(400, "id or url is required")
    return json(await checkRemote(input.url, { key: typeof input.key === "string" ? input.key : undefined }))
  }
  if (is("POST", "remote", "scan")) {
    const input = await body(req)
    const hosts = Array.isArray(input.hosts) ? input.hosts.filter((h: unknown): h is string => typeof h === "string") : undefined
    try {
      return json(await scanNetwork({ hosts, signal: req.signal }))
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err))
    }
  }
  if (is("DELETE", "remote", "*")) {
    if (!(await removeRemoteHost(parts[1]!))) throw new HttpError(404, `No saved host named ${parts[1]}`)
    return json(true)
  }
  // One page of facts for a settings screen: what is connected, loaded and where the config lives.
  if (is("GET", "status")) {
    const plugins = await loadPlugins().catch(() => [])
    return json({
      version: VERSION,
      directory: project().directory,
      worktree: project().worktree,
      configFile: globalConfigFile(),
      mcp: mcpStatus(),
      lsp: await lspStatus().catch(() => []),
      plugins: plugins.map((p) => ({ name: p.name, source: p.source })),
      pluginProblems: pluginProblems().map((p: any) => redactDeep(p)),
      snapshot: await snapshotStatus(),
    })
  }
  // Interactive terminals: output arrives as `pty.data` events, the end as `pty.exit`.
  if (is("GET", "pty")) return json(listTerminals())
  if (is("POST", "pty")) {
    const input = await body(req)
    try {
      return json(openTerminal({ cwd: typeof input.cwd === "string" ? input.cwd : undefined, cols: Number(input.cols) || undefined, rows: Number(input.rows) || undefined }), 201)
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err))
    }
  }
  if (is("POST", "pty", "*", "input")) {
    const input = await body(req)
    if (typeof input.data !== "string") throw new HttpError(400, "data is required")
    if (!writeTerminal(parts[1]!, input.data)) throw new HttpError(404, "No such terminal")
    return json(true)
  }
  if (is("POST", "pty", "*", "resize")) {
    const input = await body(req)
    if (!Number.isFinite(Number(input.cols)) || !Number.isFinite(Number(input.rows))) throw new HttpError(400, "cols and rows are required")
    if (!resizeTerminal(parts[1]!, Number(input.cols), Number(input.rows))) throw new HttpError(404, "No such terminal")
    return json(true)
  }
  if (is("DELETE", "pty", "*")) {
    if (!closeTerminal(parts[1]!)) throw new HttpError(404, "No such terminal")
    return json(true)
  }
  // What the agent changed: a unified diff against the snapshot taken before a step (the `hash` of a
  // patch part), and putting chosen files back to how they were then.
  if (is("GET", "snapshot", "status")) return json(await snapshotStatus())
  if (is("GET", "snapshot", "diff")) {
    const hash = url.searchParams.get("hash") ?? ""
    if (!/^[0-9a-f]{40,64}$/.test(hash)) throw new HttpError(400, "hash must be a snapshot id")
    const file = url.searchParams.get("file")
    const root = project().worktree
    const target = file ? path.resolve(root, file) : undefined
    if (target && !(target === root || target.startsWith(root + path.sep))) throw new HttpError(400, "file is outside the project")
    return json({ hash, file, diff: await diffSince(hash, target ? [target] : undefined) })
  }
  if (is("POST", "snapshot", "revert")) {
    const input = await body(req)
    if (typeof input.hash !== "string" || !/^[0-9a-f]{40,64}$/.test(input.hash)) throw new HttpError(400, "hash must be a snapshot id")
    if (!Array.isArray(input.files) || input.files.length === 0 || input.files.some((f: unknown) => typeof f !== "string")) throw new HttpError(400, "files must be a list of paths")
    const root = project().worktree
    const targets = (input.files as string[]).map((f) => path.resolve(root, f))
    if (targets.some((t) => !(t === root || t.startsWith(root + path.sep)))) throw new HttpError(400, "a file is outside the project")
    await revertFiles(input.hash, targets)
    return json({ reverted: targets.map((t) => path.relative(root, t).split(path.sep).join("/")), changed: (await changedFiles(input.hash)).map((f) => path.relative(root, f).split(path.sep).join("/")) })
  }
  if (is("GET", "skill")) return json(Object.values(await listSkills()).map(({ content: _content, ...rest }) => rest))
  if (is("GET", "stats")) {
    const days = url.searchParams.get("days")
    return json(await usageStats({ all: url.searchParams.get("all") === "true", days: days ? Number(days) : undefined }))
  }

  // Stored credentials: names and kinds only, never the key itself.
  if (is("GET", "auth")) {
    const stored = await allCredentials()
    const providers = await allProviders()
    const rows = Object.entries(stored).map(([id, cred]) => ({ id, name: providers[id]?.name ?? id, type: cred.type, source: "stored" }))
    for (const info of Object.values(providers)) {
      if (stored[info.id]) continue
      if (info.source === "env" || info.source === "config") rows.push({ id: info.id, name: info.name, type: "api", source: info.source })
    }
    return json(rows)
  }
  if (is("PUT", "auth", "*")) {
    const input = await body(req)
    const id = parts[1]!
    if (typeof input.key !== "string" || input.key.trim() === "") throw new HttpError(400, "key is required")
    if (!(await allProviders())[id]) throw new HttpError(404, `Unknown provider: ${id}`)
    registerSecret(input.key.trim())
    await setCredential(id, { type: "api", key: input.key.trim() })
    resetProviders()
    return json(true)
  }
  if (is("DELETE", "auth", "*")) {
    if (!(await removeCredential(parts[1]!))) throw new HttpError(404, `No stored credentials for ${parts[1]}`)
    resetProviders()
    return json(true)
  }

  // Project trust: whether the project's own config may run commands and set endpoints.
  if (is("GET", "trust")) {
    resetConfig()
    const loaded = await loadConfig()
    return json({ directory: project().worktree, trusted: loaded.trusted, blocked: loaded.blocked, projects: await trustedProjects() })
  }
  if (is("POST", "trust")) {
    await trustProject(project().worktree)
    resetConfig()
    return json({ directory: project().worktree, trusted: await isTrusted(project().worktree) })
  }
  if (is("DELETE", "trust")) {
    const removed = await untrustProject(project().worktree)
    resetConfig()
    return json({ directory: project().worktree, removed })
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
