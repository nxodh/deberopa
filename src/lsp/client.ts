import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createLogger } from "../util/log"
import { killTree, launchSpec } from "../util/shell"

const log = createLogger("lsp")

const HANDSHAKE_TIMEOUT = 15_000
const SHUTDOWN_TIMEOUT = 1_000
const EXIT_TIMEOUT = 1_000
const DEFAULT_WAIT = 3_000

export interface Diagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } }
  severity?: 1 | 2 | 3 | 4
  message: string
  source?: string
  code?: string | number
}

export interface LspClient {
  readonly serverID: string
  readonly root: string
  /** False once the process has exited or the connection is gone. */
  readonly alive: boolean
  /** didOpen on first sight, didChange (full text, incremented version) afterwards. Reads the file from disk. */
  notifyFile(file: string): Promise<void>
  /** Resolves when diagnostics for `file` arrive after this call, or after `timeoutMs` (default 3000). */
  waitForDiagnostics(file: string, timeoutMs?: number): Promise<void>
  diagnostics(): Map<string, Diagnostic[]>
  shutdown(): Promise<void>
}

const LANGUAGE_IDS: Record<string, string> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascriptreact",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".c": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".h": "cpp",
  ".hpp": "cpp",
  ".java": "java",
  ".rb": "ruby",
  ".php": "php",
  ".cs": "csharp",
  ".lua": "lua",
  ".json": "json",
  ".css": "css",
  ".html": "html",
  ".vue": "vue",
  ".svelte": "svelte",
  ".zig": "zig",
}

/** Map key for a file: absolute and normalised, with the Windows drive letter lower-cased. */
export function diagnosticKey(file: string): string {
  const normal = path.normalize(path.resolve(file))
  return process.platform === "win32" ? normal.replace(/^([A-Za-z]):/, (_, drive: string) => `${drive.toLowerCase()}:`) : normal
}

const HEADER_END = Buffer.from("\r\n\r\n")
const CONTENT_LENGTH = /(?:^|\r\n)content-length:\s*(\d+)/i

/** Incremental decoder for Content-Length framed JSON-RPC. Lengths count bytes, so framing works on raw Buffers. */
export function createMessageDecoder(onMessage: (msg: any) => void): { feed(chunk: Buffer): void } {
  let buf: Buffer = Buffer.alloc(0)
  return {
    feed(chunk: Buffer) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
      for (;;) {
        const sep = buf.indexOf(HEADER_END)
        if (sep === -1) return
        const bodyStart = sep + HEADER_END.length
        const match = CONTENT_LENGTH.exec(buf.toString("ascii", 0, sep))
        if (!match) {
          // A header without Content-Length cannot be framed; skip it.
          buf = buf.subarray(bodyStart)
          continue
        }
        const length = Number(match[1])
        if (buf.length < bodyStart + length) return
        const body = buf.toString("utf8", bodyStart, bodyStart + length)
        buf = buf.subarray(bodyStart + length)
        let msg: unknown
        try {
          msg = JSON.parse(body)
        } catch {
          log.warn("dropped a message that is not valid JSON")
          continue
        }
        onMessage(msg)
      }
    },
  }
}

export function encodeMessage(msg: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(msg), "utf8")
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body])
}

interface RpcMessage {
  id?: number | string | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string }
}

function isDiagnostic(d: unknown): d is Diagnostic {
  if (typeof d !== "object" || d === null) return false
  const { range, message } = d as { range?: { start?: { line?: unknown; character?: unknown } }; message?: unknown }
  const start = range?.start
  return !!start && typeof start.line === "number" && typeof start.character === "number" && typeof message === "string"
}

function languageId(file: string): string {
  return LANGUAGE_IDS[path.extname(file).toLowerCase()] ?? "plaintext"
}

/** Resolves when `p` settles or after `ms`, whichever comes first. */
function within(p: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
    void p.then(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

export async function createLspClient(input: {
  serverID: string
  command: string[]
  root: string
  env?: Record<string, string>
  initialization?: Record<string, unknown>
}): Promise<LspClient> {
  if (!input.command.length) throw new Error(`${input.serverID}: empty command`)
  const root = path.resolve(input.root)
  const rootUri = pathToFileURL(root).href
  const launch = launchSpec(input.command)
  const child = spawn(launch.file, launch.args, {
    cwd: root,
    env: { ...process.env, ...input.env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    windowsVerbatimArguments: launch.verbatim,
  })

  let dead = false
  let signalExit: () => void = () => {}
  const exited = new Promise<void>((resolve) => (signalExit = resolve))

  const diags = new Map<string, Diagnostic[]>()
  // Publish count per file; a waiter is satisfied once its file's count moves past its baseline.
  const publishCount = new Map<string, number>()
  // Publish count at the most recent send for a file, so a fast reply is not missed.
  const baselines = new Map<string, number>()
  const versions = new Map<string, number>()
  const listeners = new Set<(changed: string | undefined) => void>()
  let queue: Promise<void> = Promise.resolve()

  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>()
  let nextId = 1

  const send = (msg: Record<string, unknown>) => {
    if (dead || !child.stdin) return
    try {
      child.stdin.write(encodeMessage({ jsonrpc: "2.0", ...msg }))
    } catch (err) {
      markDead(err)
    }
  }

  const markDead = (reason?: unknown) => {
    if (dead) return
    dead = true
    if (reason !== undefined) log.info(`${input.serverID} stopped: ${String(reason)}`)
    const error = new Error(`${input.serverID} stopped`)
    for (const waiter of pending.values()) waiter.reject(error)
    pending.clear()
    for (const wake of [...listeners]) wake(undefined)
    listeners.clear()
    signalExit()
  }

  const request = (method: string, params: unknown, timeoutMs: number): Promise<unknown> => {
    if (dead) return Promise.reject(new Error(`${input.serverID} is not running`))
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`${input.serverID}: ${method} timed out`))
      }, timeoutMs)
      timer.unref?.()
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      })
      send({ id, method, params })
    })
  }

  const respond = (id: number | string, method: string, params: unknown) => {
    switch (method) {
      case "workspace/configuration": {
        const items = (params as { items?: unknown[] } | undefined)?.items
        return send({ id, result: Array.from({ length: Array.isArray(items) ? items.length : 0 }, () => ({})) })
      }
      case "client/registerCapability":
      case "client/unregisterCapability":
      case "window/workDoneProgress/create":
        return send({ id, result: null })
      case "workspace/workspaceFolders":
        return send({ id, result: [{ uri: rootUri, name: "workspace" }] })
      default:
        return send({ id, error: { code: -32601, message: `Method not found: ${method}` } })
    }
  }

  const publish = (params: unknown) => {
    const { uri, diagnostics } = (params ?? {}) as { uri?: unknown; diagnostics?: unknown }
    if (typeof uri !== "string") return
    let key: string
    try {
      key = diagnosticKey(fileURLToPath(uri))
    } catch {
      return
    }
    diags.set(key, Array.isArray(diagnostics) ? diagnostics.filter(isDiagnostic) : [])
    publishCount.set(key, (publishCount.get(key) ?? 0) + 1)
    for (const wake of [...listeners]) wake(key)
  }

  const handle = (msg: RpcMessage) => {
    if (typeof msg.method === "string") {
      if (msg.id !== undefined && msg.id !== null) respond(msg.id, msg.method, msg.params)
      else if (msg.method === "textDocument/publishDiagnostics") publish(msg.params)
      return
    }
    if (typeof msg.id !== "number") return
    const waiter = pending.get(msg.id)
    if (!waiter) return
    pending.delete(msg.id)
    if (msg.error) waiter.reject(new Error(`${input.serverID}: ${msg.error.message}`))
    else waiter.resolve(msg.result)
  }

  const decoder = createMessageDecoder((msg: RpcMessage) => {
    try {
      handle(msg)
    } catch (err) {
      log.error(`${input.serverID}: failed to handle a message`, err)
    }
  })

  child.on("error", (err) => markDead(err))
  child.on("exit", (code, signal) => markDead(`exit ${code ?? ""} ${signal ?? ""}`.trim()))
  child.stdin?.on("error", (err) => markDead(err))
  child.stdout?.on("data", (chunk: Buffer) => decoder.feed(chunk))
  child.stderr?.on("data", (chunk: Buffer) => log.debug(`${input.serverID} stderr: ${chunk.toString("utf8", 0, 500)}`))

  try {
    await request(
      "initialize",
      {
        processId: process.pid,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: "workspace" }],
        initializationOptions: input.initialization,
        capabilities: {
          textDocument: {
            synchronization: { didOpen: true, didChange: true },
            publishDiagnostics: { versionSupport: true },
          },
          workspace: { configuration: true, workspaceFolders: true },
        },
      },
      HANDSHAKE_TIMEOUT,
    )
  } catch (err) {
    killTree(child.pid)
    markDead()
    throw new Error(`${input.serverID} failed to start: ${err instanceof Error ? err.message : String(err)}`)
  }
  send({ method: "initialized", params: {} })

  const client: LspClient = {
    serverID: input.serverID,
    root,
    get alive() {
      return !dead
    },

    notifyFile(file: string): Promise<void> {
      if (dead) return Promise.resolve()
      const run = async () => {
        if (dead) return
        const abs = path.resolve(file)
        const key = diagnosticKey(abs)
        let text: string
        try {
          text = await fs.readFile(abs, "utf8")
        } catch {
          // Deleted or unreadable: nothing to tell the server.
          return
        }
        if (dead) return
        const uri = pathToFileURL(abs).href
        const version = (versions.get(key) ?? 0) + 1
        versions.set(key, version)
        baselines.set(key, publishCount.get(key) ?? 0)
        if (version === 1) {
          send({ method: "textDocument/didOpen", params: { textDocument: { uri, languageId: languageId(abs), version, text } } })
        } else {
          send({ method: "textDocument/didChange", params: { textDocument: { uri, version }, contentChanges: [{ text }] } })
        }
      }
      // Queued so concurrent calls reach the server in order and versions never interleave.
      const task: Promise<void> = queue.then(run).catch((err) => log.error(`${input.serverID}: notify failed`, err))
      queue = task
      return task
    },

    waitForDiagnostics(file: string, timeoutMs = DEFAULT_WAIT): Promise<void> {
      if (dead) return Promise.resolve()
      const key = diagnosticKey(file)
      const baseline = baselines.get(key) ?? publishCount.get(key) ?? 0
      return new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const done = () => {
          if (timer) clearTimeout(timer)
          listeners.delete(check)
          resolve()
        }
        const check = (changed: string | undefined) => {
          if (changed === undefined || (changed === key && (publishCount.get(key) ?? 0) > baseline)) done()
        }
        listeners.add(check)
        timer = setTimeout(done, timeoutMs)
        timer.unref?.()
        check(key)
      })
    },

    diagnostics(): Map<string, Diagnostic[]> {
      return new Map(diags)
    },

    async shutdown(): Promise<void> {
      if (!dead) {
        await request("shutdown", undefined, SHUTDOWN_TIMEOUT).catch(() => undefined)
        send({ method: "exit" })
        await within(exited, EXIT_TIMEOUT)
      }
      if (!dead) {
        killTree(child.pid)
        await within(exited, EXIT_TIMEOUT)
      }
      markDead()
    },
  }

  return client
}
