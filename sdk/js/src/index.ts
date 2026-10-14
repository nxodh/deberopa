/**
 * Client for the Deberopa HTTP API (`deberopa serve`). Zero dependencies; runs on Node 18+,
 * Bun and Deno wherever `fetch` exists.
 *
 *   const { client, close } = await startServer()          // spawns `deberopa serve`
 *   const session = await client.session.create({ title: "demo" })
 *   const reply = await client.session.prompt(session.id, { text: "explain src/index.ts" })
 *   await close()
 */

export type { Plugin, PluginContext, PluginHooks, PluginTool, PluginToolContext } from "./plugin"

export type Role = "user" | "assistant"

export interface Session {
  id: string
  projectID: string
  directory: string
  parentID?: string
  title: string
  version: string
  time: { created: number; updated: number }
  revert?: { messageID: string }
  busy?: boolean
}

export type ToolState =
  | { status: "pending"; input: unknown }
  | { status: "running"; input: unknown; title?: string; metadata?: Record<string, unknown> }
  | { status: "completed"; input: unknown; output: string; title: string; metadata: Record<string, unknown> }
  | { status: "error"; input: unknown; error: string }

export type Part =
  | { id: string; type: "text"; text: string; synthetic?: boolean }
  | { id: string; type: "reasoning"; text: string }
  | { id: string; type: "file"; mime: string; filename?: string }
  | { id: string; type: "tool"; callID: string; tool: string; state: ToolState }
  | { id: string; type: "step-start" }
  | { id: string; type: "patch"; hash: string; files: string[] }

export interface Message {
  id: string
  sessionID: string
  role: Role
  parts: Part[]
  time: { created: number; completed?: number }
  agent?: string
  providerID?: string
  modelID?: string
  tokens?: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
  cost?: number
  error?: { name: string; message: string }
}

export type ModelRef = string | { providerID: string; modelID: string }

export interface PromptInput {
  text: string
  agent?: string
  /** "provider/model" or { providerID, modelID } */
  model?: ModelRef
}

export interface PendingPermission {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  always: string[]
  title: string
  metadata: Record<string, unknown>
}

export interface Agent {
  name: string
  description?: string
  mode: "primary" | "subagent" | "all"
  builtIn: boolean
}

export interface ProviderSummary {
  id: string
  name: string
  protocol: string
  source: string
  connected: boolean
  models: Record<string, { id: string; name: string; limit: { context: number; output: number } }>
}

export interface Event {
  type: string
  properties: any
}

export class DeberopaError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown,
  ) {
    super(message)
    this.name = "DeberopaError"
  }
}

export interface ClientOptions {
  /** Default: http://127.0.0.1:4096 */
  baseUrl?: string
  /** The server's DEBEROPA_SERVER_PASSWORD, if it has one. */
  password?: string
  fetch?: typeof fetch
}

const modelBody = (model: ModelRef | undefined) => model

export function createClient(options: ClientOptions = {}) {
  const base = (options.baseUrl ?? "http://127.0.0.1:4096").replace(/\/+$/, "")
  const address = new URL(base)
  if (!["http:", "https:"].includes(address.protocol) || address.username || address.password || address.search || address.hash) throw new Error("Invalid server URL")
  if (address.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(address.hostname)) throw new Error("Remote servers require HTTPS")
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  const auth: Record<string, string> = options.password ? { authorization: "Basic " + btoa(`deberopa:${options.password}`) } : {}

  async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await doFetch(base + path, {
      method,
      headers: { ...auth, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      redirect: "error",
    })
    const text = await res.text()
    let data: unknown = text
    try {
      data = text === "" ? undefined : JSON.parse(text)
    } catch {
      // markdown export and plain-text errors
    }
    if (!res.ok) {
      const message = typeof data === "object" && data !== null && "error" in data ? String((data as any).error) : `HTTP ${res.status}`
      throw new DeberopaError(message, res.status, data)
    }
    return data as T
  }

  const get = <T>(path: string, signal?: AbortSignal) => request<T>("GET", path, undefined, signal)
  const post = <T>(path: string, body: unknown = {}, signal?: AbortSignal) => request<T>("POST", path, body, signal)
  const enc = encodeURIComponent

  return {
    health: () => get<{ name: string; version: string; ok: boolean }>("/health"),
    project: () => get<{ id: string; directory: string; worktree: string; vcs?: string }>("/project"),
    config: () => get<Record<string, unknown>>("/config"),
    agent: { list: () => get<Agent[]>("/agent") },
    command: { list: () => get<{ name: string; description?: string }[]>("/command") },
    provider: { list: () => get<{ providers: ProviderSummary[]; default?: { providerID: string; modelID: string } }>("/provider") },
    find: {
      /** Fuzzy file search in the project. */
      files: (query: string, limit = 50) => get<string[]>(`/find/file?query=${enc(query)}&limit=${limit}`),
    },
    session: {
      list: (opts: { children?: boolean } = {}) => get<Session[]>(`/session${opts.children ? "?children=true" : ""}`),
      create: (input: { title?: string; parentID?: string } = {}) => post<Session>("/session", input),
      get: (id: string) => get<Session>(`/session/${enc(id)}`),
      update: (id: string, input: { title: string }) => request<Session>("PATCH", `/session/${enc(id)}`, input),
      delete: (id: string) => request<boolean>("DELETE", `/session/${enc(id)}`),
      /** IDs of sessions that are running right now. */
      busy: () => get<string[]>("/session/status"),
      messages: (id: string) => get<Message[]>(`/session/${enc(id)}/message`),
      /** Send a prompt and wait for the agent to finish. */
      prompt: (id: string, input: PromptInput, signal?: AbortSignal) =>
        post<Message | null>(`/session/${enc(id)}/message`, { ...input, model: modelBody(input.model) }, signal),
      /** Send a prompt and return immediately; follow progress with `client.event.subscribe()`. */
      promptAsync: (id: string, input: PromptInput) =>
        post<{ accepted: boolean }>(`/session/${enc(id)}/prompt_async`, { ...input, model: modelBody(input.model) }),
      command: (id: string, input: { name: string; arguments?: string; agent?: string; model?: ModelRef }) => post<Message | null>(`/session/${enc(id)}/command`, input),
      shell: (id: string, command: string) => post<unknown>(`/session/${enc(id)}/shell`, { command }),
      abort: (id: string) => post<boolean>(`/session/${enc(id)}/abort`),
      compact: (id: string) => post<Message | null>(`/session/${enc(id)}/compact`),
      revert: (id: string, messageID: string) => post<{ session: Session; files: string[] }>(`/session/${enc(id)}/revert`, { messageID }),
      unrevert: (id: string) => post<Session>(`/session/${enc(id)}/unrevert`),
      fork: (id: string, messageID?: string) => post<Session>(`/session/${enc(id)}/fork`, messageID ? { messageID } : {}),
      /** The conversation as Markdown. */
      export: (id: string) => get<string>(`/session/${enc(id)}/export`),
    },
    permission: {
      list: () => get<PendingPermission[]>("/permission"),
      /** Answer a pending request. `message` with "reject" tells the agent why. */
      reply: (id: string, reply: "once" | "always" | "reject", message?: string) => post<boolean>(`/permission/${enc(id)}`, { reply, message }),
    },
    event: {
      /**
       * Server-sent events: message and part updates, session status, permission requests, todo
       * changes. Ends when `signal` aborts or the connection closes.
       */
      async *subscribe(signal?: AbortSignal): AsyncGenerator<Event> {
        const res = await doFetch(base + "/event", { headers: { ...auth, accept: "text/event-stream" }, signal, redirect: "error" })
        if (!res.ok || !res.body) throw new DeberopaError(`HTTP ${res.status}`, res.status)
        const decoder = new TextDecoder()
        const reader = res.body.getReader()
        let buffer = ""
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            let at: number
            while ((at = buffer.search(/\r?\n\r?\n/)) !== -1) {
              const block = buffer.slice(0, at)
              buffer = buffer.slice(at).replace(/^\r?\n\r?\n/, "")
              const data = block
                .split(/\r?\n/)
                .filter((l) => l.startsWith("data:"))
                .map((l) => l.slice(5).replace(/^ /, ""))
                .join("\n")
              if (!data) continue // comment / heartbeat
              try {
                yield JSON.parse(data) as Event
              } catch {
                // ignore a malformed frame rather than ending the stream
              }
            }
          }
        } catch (err) {
          if (!(signal?.aborted || (err instanceof Error && err.name === "AbortError"))) throw err
        } finally {
          reader.releaseLock()
        }
      },
    },
  }
}

export type Client = ReturnType<typeof createClient>

/** The text of a message: every non-synthetic text part, joined. */
export function messageText(message: Message | null | undefined): string {
  return (message?.parts ?? [])
    .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text" && !p.synthetic)
    .map((p) => p.text)
    .join("\n")
    .trim()
}

export interface StartServerOptions extends Omit<ClientOptions, "baseUrl"> {
  /** Path of the deberopa executable. Default: "deberopa" from PATH. */
  command?: string
  /** Project directory to serve. Default: the current directory. */
  cwd?: string
  port?: number
  env?: Record<string, string | undefined>
  /** Milliseconds to wait for the server to start. Default 20000. */
  timeout?: number
}

/** Spawn `deberopa serve` on a free port and return a client for it. Node/Bun only. */
export async function startServer(options: StartServerOptions = {}): Promise<{ client: Client; url: string; close(): Promise<void> }> {
  const { spawn } = await import("node:child_process")
  const password = options.password ?? options.env?.DEBEROPA_SERVER_PASSWORD ?? process.env.DEBEROPA_SERVER_PASSWORD
  const child = spawn(options.command ?? "deberopa", ["serve", "--port", String(options.port ?? 0), "--hostname", "127.0.0.1"], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env, DEBEROPA_SERVER_PASSWORD: password },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })
  const url = await new Promise<string>((resolve, reject) => {
    let output = ""
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`deberopa serve did not start within ${(options.timeout ?? 20_000) / 1000}s:\n${output.trim()}`))
    }, options.timeout ?? 20_000)
    const onData = (chunk: Buffer) => {
      output += chunk.toString()
      const match = /listening on (http:\/\/\S+)/.exec(output)
      if (match) {
        clearTimeout(timer)
        resolve(match[1]!)
      }
    }
    child.stdout?.on("data", onData)
    child.stderr?.on("data", (c) => (output += c.toString()))
    child.on("error", (err) => {
      clearTimeout(timer)
      reject(new Error(`could not run "${options.command ?? "deberopa"}": ${err.message}`))
    })
    child.on("exit", (code) => {
      clearTimeout(timer)
      reject(new Error(`deberopa serve exited with code ${code}:\n${output.trim()}`))
    })
  })
  const client = createClient({ baseUrl: url, password, fetch: options.fetch })
  return {
    client,
    url,
    close: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve()
        child.once("exit", () => resolve())
        child.kill()
        setTimeout(() => resolve(), 3000).unref?.()
      }),
  }
}
