import path from "node:path"
import fs from "node:fs/promises"
import os from "node:os"
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser"
import { Paths, NAME } from "../global"
import { project } from "../project"
import { exists, findUp } from "../util/fs"
import { createLogger } from "../util/log"
import type { McpServerConfig } from "../mcp/client"

const log = createLogger("config")

export type PermissionAction = "allow" | "ask" | "deny"
export type PermissionRule = PermissionAction | Record<string, PermissionAction>
export type PermissionConfig = PermissionAction | Record<string, PermissionRule>

export interface ModelConfig {
  id?: string
  name?: string
  limit?: { context?: number; output?: number }
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number }
  reasoning?: boolean
  tool_call?: boolean
  attachment?: boolean
  temperature?: boolean
  options?: Record<string, unknown>
}

export interface ProviderConfig {
  name?: string
  /** Wire protocol. Defaults to "openai" (chat completions) for anything that is not Anthropic. */
  protocol?: "anthropic" | "openai" | "ollama"
  /** Base URL of the API. */
  api?: string
  /** Environment variables that may hold the API key. */
  env?: string[]
  options?: { apiKey?: string; baseURL?: string; headers?: Record<string, string>; timeout?: number }
  models?: Record<string, ModelConfig>
}

export interface AgentConfig {
  description?: string
  mode?: "primary" | "subagent" | "all"
  model?: string
  prompt?: string
  temperature?: number
  top_p?: number
  /** Maximum agentic iterations before the agent must answer in text. */
  steps?: number
  tools?: Record<string, boolean>
  permission?: PermissionConfig
  disable?: boolean
  hidden?: boolean
  reasoning_effort?: string
}

export interface CommandConfig {
  template: string
  description?: string
  agent?: string
  model?: string
  subtask?: boolean
}

export interface FormatterConfig {
  disabled?: boolean
  command?: string[]
  extensions?: string[]
  environment?: Record<string, string>
}

export interface LspConfig {
  disabled?: boolean
  command?: string[]
  extensions?: string[]
  env?: Record<string, string>
  initialization?: Record<string, unknown>
}

export interface Config {
  $schema?: string
  theme?: string
  /** "provider/model" */
  model?: string
  small_model?: string
  default_agent?: string
  username?: string
  autoupdate?: boolean | "notify"
  snapshot?: boolean
  /** false stops Vedecaps from offering to install missing language servers. */
  lsp_install?: boolean
  /** Web search through Exa. A key lifts the shared free-tier limit. */
  websearch?: { enabled?: boolean; apiKey?: string }
  /** false skips probing localhost for Ollama, LM Studio, llama.cpp and vLLM at startup. */
  local_detect?: boolean
  reasoning_effort?: "low" | "medium" | "high" | "xhigh" | "max"
  provider?: Record<string, ProviderConfig>
  disabled_providers?: string[]
  enabled_providers?: string[]
  agent?: Record<string, AgentConfig>
  command?: Record<string, CommandConfig>
  mcp?: Record<string, McpServerConfig>
  permission?: PermissionConfig
  instructions?: string[]
  tools?: Record<string, boolean>
  formatter?: false | Record<string, FormatterConfig>
  lsp?: false | Record<string, LspConfig>
  keybinds?: Record<string, string>
  compaction?: { auto?: boolean; reserved?: number }
  server?: { port?: number; hostname?: string }
}

export interface LoadedConfig {
  config: Config
  /** Config directories, lowest precedence first (global, then project `.vedecaps` dirs root → cwd). */
  directories: string[]
  /** Files that were actually read, lowest precedence first. */
  files: string[]
  errors: string[]
}

const FILE_NAMES = [`${NAME}.jsonc`, `${NAME}.json`]

let cached: Promise<LoadedConfig> | undefined

export function loadConfig(): Promise<LoadedConfig> {
  return (cached ??= load())
}

export function resetConfig() {
  cached = undefined
}

export async function getConfig(): Promise<Config> {
  return (await loadConfig()).config
}

export function globalConfigFile(): string {
  return path.join(Paths.config, `${NAME}.json`)
}

async function load(): Promise<LoadedConfig> {
  const { directory, worktree } = project()
  const errors: string[] = []
  const files: string[] = []
  let config: Config = {}

  const merge = async (file: string) => {
    if (!(await exists(file))) return
    try {
      const parsed = await readConfigFile(file)
      config = mergeConfig(config, parsed)
      files.push(file)
    } catch (err) {
      const message = `${file}: ${err instanceof Error ? err.message : String(err)}`
      errors.push(message)
      log.error("failed to load config", message)
    }
  }

  for (const name of FILE_NAMES) await merge(path.join(Paths.config, name))
  if (process.env.VEDECAPS_CONFIG) await merge(path.resolve(process.env.VEDECAPS_CONFIG))

  // Project files apply root → cwd so the nearest file wins.
  const projectFiles = (await findUp(FILE_NAMES, directory, worktree)).reverse()
  for (const file of projectFiles) await merge(file)

  const dotDirs = (await findUp([`.${NAME}`], directory, worktree)).reverse()
  for (const dir of dotDirs) for (const name of FILE_NAMES) await merge(path.join(dir, name))

  if (process.env.VEDECAPS_CONFIG_CONTENT) {
    try {
      config = mergeConfig(config, parseText(process.env.VEDECAPS_CONFIG_CONTENT, "VEDECAPS_CONFIG_CONTENT"))
    } catch (err) {
      errors.push(`VEDECAPS_CONFIG_CONTENT: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return { config, directories: [Paths.config, ...dotDirs], files, errors }
}

function parseText(text: string, label: string): Config {
  const parseErrors: ParseError[] = []
  const value = parseJsonc(text, parseErrors, { allowTrailingComma: true })
  if (parseErrors.length) {
    const first = parseErrors[0]!
    const line = text.slice(0, first.offset).split("\n").length
    throw new Error(`invalid JSON in ${label} at line ${line}: ${printParseErrorCode(first.error)}`)
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("config must be a JSON object")
  return value as Config
}

async function readConfigFile(file: string): Promise<Config> {
  let text = await fs.readFile(file, "utf8")
  // {env:NAME} → environment variable (empty when unset)
  text = text.replace(/\{env:([^}]+)\}/g, (_, name: string) => JSON.stringify(process.env[name.trim()] ?? "").slice(1, -1))
  // {file:path} → file contents, relative to the config file; ~ expands to home
  const refs = [...text.matchAll(/\{file:([^}]+)\}/g)]
  for (const ref of refs) {
    let target = (ref[1] ?? "").trim()
    if (target.startsWith("~/")) target = path.join(os.homedir(), target.slice(2))
    if (!path.isAbsolute(target)) target = path.resolve(path.dirname(file), target)
    let content: string
    try {
      content = (await fs.readFile(target, "utf8")).trim()
    } catch {
      throw new Error(`{file:${ref[1]}} could not be read (${target})`)
    }
    text = text.replace(ref[0], () => JSON.stringify(content).slice(1, -1))
  }
  return parseText(text, path.basename(file))
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** Deep merge where `b` wins; `instructions` accumulate instead of replacing. */
export function mergeConfig<T extends Record<string, any>>(a: T, b: T, pathKey = ""): T {
  const out: Record<string, any> = { ...a }
  for (const [key, value] of Object.entries(b)) {
    const existing = out[key]
    if (pathKey === "" && key === "instructions" && Array.isArray(existing) && Array.isArray(value)) {
      out[key] = [...new Set([...existing, ...value])]
    } else if (isPlainObject(existing) && isPlainObject(value)) {
      out[key] = mergeConfig(existing, value, pathKey ? `${pathKey}.${key}` : key)
    } else out[key] = value
  }
  return out as T
}

/** Persist a change to the user's global config file, keeping whatever else is there. */
export async function updateGlobalConfig(patch: Config) {
  const file = globalConfigFile()
  let current: Config = {}
  if (await exists(file)) {
    try {
      current = parseText(await fs.readFile(file, "utf8"), path.basename(file))
    } catch {
      // never clobber a file we could not parse
      throw new Error(`Refusing to modify ${file}: it contains invalid JSON.`)
    }
  }
  const next = mergeConfig(current, patch)
  if (!next.$schema) next.$schema = `https://raw.githubusercontent.com/nxodh/vedecaps/main/config.schema.json`
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(next, null, 2) + "\n")
  resetConfig()
}

/** Small persisted UI state (last used model/agent, theme) kept out of the config file. */
export interface State {
  model?: { providerID: string; modelID: string }
  agent?: string
  theme?: string
  recentModels?: string[]
  lastUpdateCheck?: number
  latestVersion?: string
}

const stateFile = () => path.join(Paths.state, "state.json")

export async function readState(): Promise<State> {
  try {
    return JSON.parse(await fs.readFile(stateFile(), "utf8")) as State
  } catch {
    return {}
  }
}

export async function writeState(patch: Partial<State>) {
  const next = { ...(await readState()), ...patch }
  await fs.mkdir(Paths.state, { recursive: true })
  await fs.writeFile(stateFile(), JSON.stringify(next, null, 2))
}
