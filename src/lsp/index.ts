import path from "node:path"
import { getConfig } from "../config/config"
import { project } from "../project"
import { exists, findUp, isInside } from "../util/fs"
import { createLogger } from "../util/log"
import { which } from "../util/shell"
import { createLspClient, diagnosticKey, type Diagnostic, type LspClient } from "./client"

const log = createLogger("lsp")

const WAIT_MS = 3000
const MAX_REPORTED = 20

export interface LspServerInfo {
  id: string
  extensions: string[]
  /** Files marking a project root, searched upward from the file to the worktree. */
  rootMarkers: string[]
  /** Resolve the launch command, or undefined when the server is not installed. */
  resolve(root: string): Promise<string[] | undefined>
  initialization?: Record<string, unknown>
}

/** Project-local node_modules first, then PATH. Never installs anything. */
async function findBin(root: string, name: string): Promise<string | undefined> {
  const local = path.join(root, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name)
  if (await exists(local)) return local
  return which(name)
}

function launch(bin: string | undefined, args: string[]): string[] | undefined {
  return bin ? [bin, ...args] : undefined
}

export const BUILTIN_SERVERS: LspServerInfo[] = [
  {
    id: "typescript",
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
    rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json"],
    resolve: async (root) => launch(await findBin(root, "typescript-language-server"), ["--stdio"]),
  },
  {
    id: "gopls",
    extensions: [".go"],
    rootMarkers: ["go.mod", "go.work"],
    resolve: async () => launch(which("gopls"), []),
  },
  {
    id: "pyright",
    extensions: [".py", ".pyi"],
    rootMarkers: ["pyproject.toml", "setup.py", "requirements.txt", "pyrightconfig.json"],
    resolve: async (root) =>
      launch((await findBin(root, "pyright-langserver")) ?? which("basedpyright-langserver"), ["--stdio"]),
  },
  {
    id: "rust-analyzer",
    extensions: [".rs"],
    rootMarkers: ["Cargo.toml"],
    resolve: async () => launch(which("rust-analyzer"), []),
  },
  {
    id: "clangd",
    extensions: [".c", ".cc", ".cpp", ".cxx", ".h", ".hpp"],
    rootMarkers: ["compile_commands.json", "compile_flags.txt", ".clangd"],
    resolve: async () => launch(which("clangd"), []),
  },
  {
    id: "ruby-lsp",
    extensions: [".rb"],
    rootMarkers: ["Gemfile"],
    resolve: async () => launch(which("ruby-lsp"), []),
  },
  {
    id: "zls",
    extensions: [".zig"],
    rootMarkers: ["build.zig"],
    resolve: async () => launch(which("zls"), []),
  },
  {
    id: "lua-language-server",
    extensions: [".lua"],
    rootMarkers: [".luarc.json"],
    resolve: async () => launch(which("lua-language-server"), []),
  },
]

/** A server after config has been merged over the built-ins. */
interface ActiveServer {
  id: string
  extensions: string[]
  rootMarkers: string[]
  command?: string[]
  resolve(root: string): Promise<string[] | undefined>
  env?: Record<string, string>
  initialization?: Record<string, unknown>
}

function normalizeExtensions(list: string[]): string[] {
  return list.map((ext) => (ext.startsWith(".") ? ext : `.${ext}`).toLowerCase())
}

async function activeServers(): Promise<ActiveServer[]> {
  const config = await getConfig()
  if (config.lsp === false) return []
  const overrides = config.lsp ?? {}
  const servers: ActiveServer[] = []

  for (const builtin of BUILTIN_SERVERS) {
    const override = overrides[builtin.id]
    if (override?.disabled) continue
    servers.push({
      id: builtin.id,
      extensions: normalizeExtensions(override?.extensions ?? builtin.extensions),
      rootMarkers: builtin.rootMarkers,
      command: override?.command?.length ? override.command : undefined,
      resolve: builtin.resolve,
      env: override?.env,
      initialization:
        builtin.initialization || override?.initialization ? { ...builtin.initialization, ...override?.initialization } : undefined,
    })
  }

  const builtinIDs = new Set(BUILTIN_SERVERS.map((s) => s.id))
  for (const [id, entry] of Object.entries(overrides)) {
    if (builtinIDs.has(id) || entry.disabled) continue
    if (!entry.command?.length || !entry.extensions?.length) {
      log.warn(`lsp.${id} needs both "command" and "extensions" to define a custom server`)
      continue
    }
    servers.push({
      id,
      extensions: normalizeExtensions(entry.extensions),
      // Custom servers have no markers, so they run at the worktree root.
      rootMarkers: [],
      command: entry.command,
      resolve: async () => undefined,
      env: entry.env,
      initialization: entry.initialization,
    })
  }
  return servers
}

/** Nearest directory holding a marker, bounded by the worktree; the worktree when none matches. */
async function rootFor(file: string, markers: string[], worktree: string): Promise<string> {
  if (!markers.length || !isInside(worktree, file)) return worktree
  const [nearest] = await findUp(markers, path.dirname(file), worktree)
  return nearest ? path.dirname(nearest) : worktree
}

interface Entry {
  id: string
  root: string
  /** Resolves to undefined when the server is missing or failed to start; that is remembered too. */
  ready: Promise<LspClient | undefined>
  client?: LspClient
}

/** One entry per (server, root), memoised so concurrent touches never spawn twice. */
const entries = new Map<string, Entry>()

function ensureClient(spec: ActiveServer, root: string): Promise<LspClient | undefined> {
  const key = `${spec.id}\n${diagnosticKey(root)}`
  const existing = entries.get(key)
  if (existing) return existing.ready
  const entry: Entry = { id: spec.id, root, ready: Promise.resolve(undefined) }
  entries.set(key, entry)
  entry.ready = connect(spec, root).then((client) => {
    entry.client = client
    return client
  })
  return entry.ready
}

async function connect(spec: ActiveServer, root: string): Promise<LspClient | undefined> {
  try {
    const command = spec.command ?? (await spec.resolve(root))
    if (!command?.length) {
      log.info(`${spec.id}: not installed, skipping ${root}`)
      return undefined
    }
    return await createLspClient({ serverID: spec.id, command, root, env: spec.env, initialization: spec.initialization })
  } catch (err) {
    log.warn(`${spec.id}: could not start for ${root}`, err)
    return undefined
  }
}

/** Tell the right server(s) about a changed file. When `wait` is true, waits (bounded) for fresh diagnostics. Never throws. */
export async function touchFile(file: string, wait = false): Promise<void> {
  try {
    const abs = path.resolve(file)
    const ext = path.extname(abs).toLowerCase()
    const matches = (await activeServers()).filter((spec) => spec.extensions.includes(ext))
    if (!matches.length) return
    const { worktree } = project()
    await Promise.all(
      matches.map(async (spec) => {
        const root = await rootFor(abs, spec.rootMarkers, worktree)
        const client = await ensureClient(spec, root)
        if (!client) return
        await client.notifyFile(abs)
        if (wait) await client.waitForDiagnostics(abs, WAIT_MS)
      }),
    )
  } catch (err) {
    log.warn(`touchFile failed for ${file}`, err)
  }
}

/** All known diagnostics, keyed by absolute path. */
export function allDiagnostics(): Record<string, Diagnostic[]> {
  const out: Record<string, Diagnostic[]> = {}
  for (const entry of entries.values()) {
    const diags = entry.client?.diagnostics()
    if (!diags) continue
    for (const [file, list] of diags) {
      if (!list.length) continue
      out[file] = [...(out[file] ?? []), ...list]
    }
  }
  return out
}

/** Human/model readable errors for one file, or "" when there are none. Only severity 1 (errors). */
export function formatDiagnostics(file: string): string {
  const key = diagnosticKey(file)
  const errors: Diagnostic[] = []
  for (const entry of entries.values()) {
    for (const d of entry.client?.diagnostics().get(key) ?? []) {
      if (d.severity === 1) errors.push(d)
    }
  }
  if (!errors.length) return ""
  errors.sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character)
  const lines = errors.slice(0, MAX_REPORTED).map((d) => {
    const message = d.message.replace(/\s*\n\s*/g, " ")
    return `ERROR [${d.range.start.line + 1}:${d.range.start.character + 1}] ${message}`
  })
  if (errors.length > MAX_REPORTED) lines.push(`... and ${errors.length - MAX_REPORTED} more`)
  return lines.join("\n")
}

export async function lspStatus(): Promise<Array<{ id: string; root: string; connected: boolean }>> {
  return [...entries.values()].map((entry) => ({ id: entry.id, root: entry.root, connected: entry.client?.alive ?? false }))
}

export async function shutdownLsp(): Promise<void> {
  const all = [...entries.values()]
  entries.clear()
  await Promise.all(
    all.map(async (entry) => {
      try {
        const client = await entry.ready
        await client?.shutdown()
      } catch (err) {
        log.warn(`${entry.id}: shutdown failed`, err)
      }
    }),
  )
}
