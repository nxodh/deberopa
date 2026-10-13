import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Paths, VERSION } from "../global"
import { project } from "../project"
import { loadConfig } from "../config/config"
import { subscribe, type BusEvent } from "../util/bus"
import { createLogger } from "../util/log"
import { redact } from "../util/redact"
import { defineTool, type JSONSchema, type ToolContext, type ToolDefinition, type ToolResult } from "../tool/tool"

const log = createLogger("plugin")

/**
 * Plugins are ES modules that export a function (default export, or a named `plugin`). The
 * function receives a context and returns hooks. They run in-process with the user's full
 * rights, so only plugins from the user's own config directory, the `plugin` setting, or a
 * *trusted* project are loaded.
 */
export interface PluginContext {
  directory: string
  worktree: string
  version: string
  log: { info(message: string): void; warn(message: string): void; error(message: string): void }
}

export interface PluginTool {
  description: string
  /** JSON Schema of the arguments (type: "object"). */
  parameters: JSONSchema
  execute(args: any, ctx: ToolContext): Promise<string | (Partial<ToolResult> & { output: string })> | string
}

export interface PluginHooks {
  /** Extra tools for the model, keyed by tool name. */
  tool?: Record<string, PluginTool>
  /** Every bus event: message and part updates, session status, permissions, file edits, ... */
  event?(event: BusEvent): void | Promise<void>
  /** Inspect or rewrite a tool call's arguments. Throw to block the call; the message goes to the model. */
  "tool.execute.before"?(input: { tool: string; sessionID: string; callID: string }, output: { args: any }): void | Promise<void>
  /** Inspect or rewrite a tool's result before the model sees it. */
  "tool.execute.after"?(input: { tool: string; sessionID: string; callID: string }, output: { title: string; output: string; metadata: Record<string, unknown> }): void | Promise<void>
  /** Add to or change the system prompt blocks of a request. Keep it deterministic to keep prompt caching effective. */
  "chat.system"?(input: { agent: string; providerID: string; modelID: string }, output: { system: string[] }): void | Promise<void>
}

export type Plugin = (context: PluginContext) => PluginHooks | Promise<PluginHooks>

export interface LoadedPlugin {
  name: string
  file: string
  source: "user" | "project" | "config"
  hooks: PluginHooks
}

export class PluginBlockedError extends Error {
  constructor(
    public plugin: string,
    message: string,
  ) {
    super(`Blocked by plugin ${plugin}: ${message}`)
    this.name = "PluginBlockedError"
  }
}

const EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".mts"])

let loading: Promise<LoadedPlugin[]> | undefined
let unsubscribe: (() => void) | undefined
const failures: { file: string; error: string }[] = []

export function resetPlugins() {
  loading = undefined
  unsubscribe?.()
  unsubscribe = undefined
  failures.length = 0
}

async function filesIn(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  return entries
    .filter((e) => e.isFile() && EXTENSIONS.has(path.extname(e.name)) && !e.name.endsWith(".d.ts") && !e.name.startsWith("."))
    .map((e) => path.join(dir, e.name))
    .sort()
}

export function loadPlugins(): Promise<LoadedPlugin[]> {
  return (loading ??= discover())
}

async function discover(): Promise<LoadedPlugin[]> {
  const loaded = await loadConfig()
  const { worktree, directory } = project()
  const found: { file: string; source: LoadedPlugin["source"] }[] = []

  for (const file of await filesIn(path.join(Paths.config, "plugin"))) found.push({ file, source: "user" })
  for (const entry of loaded.config.plugin ?? []) {
    const candidates = path.isAbsolute(entry) ? [entry] : [path.resolve(worktree, entry), path.resolve(Paths.config, entry)]
    let resolved: string | undefined
    for (const c of candidates) if (await fs.stat(c).then((s) => s.isFile(), () => false)) resolved = c
    if (resolved) found.push({ file: resolved, source: "config" })
    else failures.push({ file: entry, error: "file not found (plugins are local files; relative paths are tried against the project and the config directory)" })
  }
  // A repository's own plugin folder runs arbitrary code, so it needs the user's trust.
  if (loaded.trusted) {
    for (const dir of loaded.directories.filter((d) => d !== Paths.config)) {
      for (const file of await filesIn(path.join(dir, "plugin"))) found.push({ file, source: "project" })
    }
  }
  // (an untrusted project's plugin folder is reported by the config loader)

  const seen = new Set<string>()
  const plugins: LoadedPlugin[] = []
  for (const { file, source } of found) {
    const key = path.resolve(file)
    if (seen.has(key)) continue
    seen.add(key)
    const name = path.basename(file, path.extname(file))
    try {
      const mtime = (await fs.stat(file)).mtimeMs
      const mod: any = await import(`${pathToFileURL(file).href}?v=${mtime}`)
      const factory = mod.default ?? mod.plugin
      if (factory === undefined) throw new Error("the module has no default export (or `plugin` export)")
      const context: PluginContext = {
        directory,
        worktree,
        version: VERSION,
        log: {
          info: (m) => log.info(`[${name}] ${redact(String(m))}`),
          warn: (m) => log.warn(`[${name}] ${redact(String(m))}`),
          error: (m) => log.error(`[${name}] ${redact(String(m))}`),
        },
      }
      const hooks: PluginHooks = typeof factory === "function" ? await factory(context) : factory
      if (!hooks || typeof hooks !== "object") throw new Error("the plugin function must return an object of hooks")
      plugins.push({ name, file, source, hooks })
      log.info(`loaded plugin ${name} (${source})`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      failures.push({ file, error: message })
      log.error(`plugin ${file} failed to load`, err)
    }
  }

  if (plugins.some((p) => p.hooks.event)) {
    unsubscribe = subscribe("*", (event) => {
      for (const p of plugins) {
        if (!p.hooks.event) continue
        try {
          const result = p.hooks.event(event)
          if (result && typeof (result as Promise<void>).catch === "function") (result as Promise<void>).catch((e) => log.warn(`[${p.name}] event hook failed`, e))
        } catch (err) {
          log.warn(`[${p.name}] event hook failed`, err)
        }
      }
    })
  }
  return plugins
}

export function pluginProblems() {
  return [...failures]
}

/** Tools contributed by plugins. A tool whose name is already taken by a built-in is skipped. */
export async function pluginTools(taken: Set<string>): Promise<ToolDefinition[]> {
  const out: ToolDefinition[] = []
  for (const plugin of await loadPlugins()) {
    for (const [id, tool] of Object.entries(plugin.hooks.tool ?? {})) {
      if (taken.has(id) || out.some((t) => t.id === id)) {
        log.warn(`plugin ${plugin.name}: tool "${id}" clashes with an existing tool and was skipped`)
        continue
      }
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || typeof tool?.execute !== "function" || typeof tool.description !== "string") {
        log.warn(`plugin ${plugin.name}: tool "${id}" is malformed and was skipped`)
        continue
      }
      const parameters = tool.parameters && typeof tool.parameters === "object" ? { ...tool.parameters } : {}
      if (parameters.type !== "object") parameters.type = "object"
      if (!parameters.properties) parameters.properties = {}
      out.push(
        defineTool({
          id,
          description: tool.description,
          parameters,
          async execute(args, ctx) {
            const result = await tool.execute(args, ctx)
            if (typeof result === "string") return { title: id, output: result }
            return { title: result.title ?? id, output: String(result.output ?? ""), metadata: result.metadata, attachments: result.attachments }
          },
        }),
      )
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

type HookName = "tool.execute.before" | "tool.execute.after" | "chat.system"

/**
 * Run a hook on every plugin in order. `blocking` hooks may throw to veto (tool.execute.before);
 * every other failure is logged and skipped so a buggy plugin cannot break the agent.
 */
export async function runHook<N extends HookName>(name: N, input: Parameters<NonNullable<PluginHooks[N]>>[0], output: Parameters<NonNullable<PluginHooks[N]>>[1]): Promise<void> {
  for (const plugin of await loadPlugins()) {
    const hook = plugin.hooks[name] as ((i: unknown, o: unknown) => void | Promise<void>) | undefined
    if (!hook) continue
    try {
      await hook(input, output)
    } catch (err) {
      if (name === "tool.execute.before") throw new PluginBlockedError(plugin.name, err instanceof Error ? err.message : String(err))
      log.warn(`[${plugin.name}] ${name} hook failed`, err)
    }
  }
}
