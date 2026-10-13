import fs from "node:fs/promises"
import path from "node:path"
import { Paths } from "../global"
import type { Config } from "./config"

/**
 * A repository's own config can say things like "run this command at startup" or "send your
 * API key to this URL". That is fine for a project you chose to trust and dangerous for one
 * you just cloned, so those parts are ignored until the user trusts the folder.
 */
const file = () => path.join(Paths.state, "trusted-projects.json")
const norm = (p: string) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p))

async function read(): Promise<string[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(file(), "utf8"))
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : []
  } catch {
    return []
  }
}

export async function trustedProjects(): Promise<string[]> {
  return read()
}

export async function isTrusted(worktree: string): Promise<boolean> {
  // CI and scripted use: the operator vouches for the checkout
  if (process.env.VEDECAPS_TRUST_PROJECT === "1") return true
  const target = norm(worktree)
  return (await read()).some((p) => norm(p) === target)
}

export async function trustProject(worktree: string): Promise<void> {
  const list = await read()
  if (list.some((p) => norm(p) === norm(worktree))) return
  await fs.mkdir(path.dirname(file()), { recursive: true })
  await fs.writeFile(file(), JSON.stringify([...list, path.resolve(worktree)], null, 2))
}

export async function untrustProject(worktree: string): Promise<boolean> {
  const list = await read()
  const next = list.filter((p) => norm(p) !== norm(worktree))
  if (next.length === list.length) return false
  await fs.writeFile(file(), JSON.stringify(next, null, 2))
  return true
}

/**
 * Remove everything from a project-supplied config that can run code or move credentials.
 * Returns what was removed so the user can be told. The input is not modified.
 */
export function stripUntrusted(input: Config): { config: Config; blocked: string[] } {
  const blocked: string[] = []
  const config: Config = structuredClone(input)
  for (const key of ["command", "server", "keybinds"] as const) {
    if (config[key] !== undefined) {
      blocked.push(`${key} (execution or user controls)`)
      delete config[key]
    }
  }

  for (const name of Object.keys(config.mcp ?? {})) {
    const server = config.mcp![name]!
    blocked.push(`mcp.${name} (${server.type === "local" ? "starts a program" : "connects to a server"})`)
    delete config.mcp![name]
  }
  if (config.mcp && Object.keys(config.mcp).length === 0) delete config.mcp

  if (config.formatter && typeof config.formatter === "object") {
    for (const [name, entry] of Object.entries(config.formatter)) {
      if (entry.command || entry.environment) {
        blocked.push(`formatter.${name} (runs a command)`)
        delete config.formatter[name]
      }
    }
  }
  if (config.lsp && typeof config.lsp === "object") {
    for (const [name, entry] of Object.entries(config.lsp)) {
      if (entry.command || entry.env) {
        blocked.push(`lsp.${name} (starts a program)`)
        delete config.lsp[name]
      }
    }
  }
  if (config.plugin?.length) {
    blocked.push(`plugin (${config.plugin.length} plugin${config.plugin.length === 1 ? "" : "s"})`)
    delete config.plugin
  }

  // Endpoints and header/env lookups decide where an API key is sent.
  for (const [id, provider] of Object.entries(config.provider ?? {})) {
    const moved: string[] = []
    if (provider.api) moved.push("api")
    if (provider.env) moved.push("env")
    if (provider.options?.baseURL) moved.push("baseURL")
    if (provider.options?.headers) moved.push("headers")
    if (moved.length) {
      blocked.push(`provider.${id}.${moved.join("/")} (decides where requests and keys go)`)
      delete provider.api
      delete provider.env
      if (provider.options) {
        delete provider.options.baseURL
        delete provider.options.headers
      }
    }
  }

  // A repository must not be able to switch off the questions the user would be asked.
  if (config.permission !== undefined) {
    const before = JSON.stringify(config.permission)
    config.permission = dropAllow(config.permission)
    if (config.permission === undefined || JSON.stringify(config.permission) !== before) blocked.push("permission (rules that allow without asking)")
    if (config.permission === undefined) delete config.permission
  }
  for (const [name, agent] of Object.entries(config.agent ?? {})) {
    if (agent.permission === undefined) continue
    const before = JSON.stringify(agent.permission)
    agent.permission = dropAllow(agent.permission)
    if (agent.permission === undefined) delete agent.permission
    if (JSON.stringify(agent.permission) !== before) blocked.push(`agent.${name}.permission (rules that allow without asking)`)
  }
  return { config, blocked }
}

export function dropAllow<T>(value: T): T | undefined {
  if (value === "allow") return undefined
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const kept = dropAllow(v)
      if (kept !== undefined && !(typeof kept === "object" && Object.keys(kept as object).length === 0)) out[key] = kept
    }
    return (Object.keys(out).length ? out : undefined) as T | undefined
  }
  return value
}
