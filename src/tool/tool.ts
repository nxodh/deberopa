import path from "node:path"
import { isInside } from "../util/fs"

export type JSONSchema = Record<string, any>

export interface PermissionRequest {
  /** Permission key, e.g. "edit", "bash", "webfetch", "external_directory". */
  permission: string
  /** Concrete things being accessed (a command line, a file path, a URL). */
  patterns: string[]
  /** Short human-readable description shown in the prompt. */
  title: string
  /** Patterns to remember if the user answers "always". Defaults to `patterns`. */
  always?: string[]
  metadata?: Record<string, unknown>
}

export interface ToolContext {
  sessionID: string
  messageID: string
  callID: string
  agent: string
  abort: AbortSignal
  /** Working directory of the session. Relative paths resolve against this. */
  directory: string
  /** Project root (git root when there is one, otherwise `directory`). */
  worktree: string
  /** Resolves when allowed; throws `PermissionDeniedError` when rejected. */
  ask(request: PermissionRequest): Promise<void>
  /** Push live progress (title / metadata) while the tool is still running. */
  metadata(update: { title?: string; metadata?: Record<string, unknown> }): void
}

export interface ToolAttachment {
  mime: string
  filename?: string
  /** base64 payload */
  data: string
}

export interface ToolResult {
  title: string
  output: string
  metadata?: Record<string, unknown>
  attachments?: ToolAttachment[]
}

export interface ToolDefinition<Args = any> {
  id: string
  description: string
  /** JSON Schema (type: "object") describing the arguments. */
  parameters: JSONSchema
  execute(args: Args, ctx: ToolContext): Promise<ToolResult>
}

export function defineTool<Args = any>(def: ToolDefinition<Args>): ToolDefinition<Args> {
  return def
}

export class PermissionDeniedError extends Error {
  constructor(message = "The user rejected permission to use this specific tool call.") {
    super(message)
    this.name = "PermissionDeniedError"
  }
}

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ToolInputError"
  }
}

export const MAX_OUTPUT_LINES = 2000
export const MAX_OUTPUT_BYTES = 50 * 1024

/** Cap tool output so one noisy command cannot flood the context window. */
export function truncateOutput(
  text: string,
  opts: { maxLines?: number; maxBytes?: number; direction?: "head" | "tail" } = {},
): { content: string; truncated: boolean } {
  const maxLines = opts.maxLines ?? MAX_OUTPUT_LINES
  const maxBytes = opts.maxBytes ?? MAX_OUTPUT_BYTES
  const lines = text.split("\n")
  if (lines.length <= maxLines && Buffer.byteLength(text, "utf8") <= maxBytes) return { content: text, truncated: false }

  const kept: string[] = []
  let bytes = 0
  const source = opts.direction === "tail" ? [...lines].reverse() : lines
  for (const line of source) {
    const size = Buffer.byteLength(line, "utf8") + 1
    if (kept.length >= maxLines || bytes + size > maxBytes) break
    kept.push(line)
    bytes += size
  }
  const omitted = lines.length - kept.length
  if (opts.direction === "tail") {
    kept.reverse()
    return { content: `... (${omitted} earlier lines truncated)\n${kept.join("\n")}`, truncated: true }
  }
  return { content: `${kept.join("\n")}\n... (${omitted} more lines truncated)`, truncated: true }
}

/** Resolve a user/model supplied path against the session directory. */
export function resolvePath(ctx: Pick<ToolContext, "directory">, input: string): string {
  let p = input.trim()
  if (p.startsWith("~/") || p === "~") p = path.join(process.env.HOME || process.env.USERPROFILE || "", p.slice(1))
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(ctx.directory, p)
}

/** Paths outside the project need explicit consent. */
export async function assertInsideProject(ctx: ToolContext, target: string, kind: "file" | "directory" = "file") {
  if (isInside(ctx.worktree, target) || isInside(ctx.directory, target)) return
  const dir = kind === "directory" ? target : path.dirname(target)
  await ctx.ask({
    permission: "external_directory",
    patterns: [target],
    always: [path.join(dir, "*")],
    title: `Access ${kind} outside the project: ${target}`,
    metadata: { path: target },
  })
}

/**
 * Minimal JSON Schema check for tool arguments. Models occasionally send truncated or
 * mistyped input, and failing loudly here gives them a message they can correct from.
 */
export function validateArgs(schema: JSONSchema, value: unknown, at = "arguments"): string | undefined {
  if (!schema || typeof schema !== "object") return undefined
  const type = schema.type
  if (schema.enum && !schema.enum.includes(value)) return `${at} must be one of: ${schema.enum.join(", ")}`
  if (type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return `${at} must be an object`
    const obj = value as Record<string, unknown>
    for (const key of schema.required ?? []) {
      if (obj[key] === undefined || obj[key] === null) return `${at} is missing required property "${key}"`
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (obj[key] === undefined || obj[key] === null) continue
      const err = validateArgs(sub as JSONSchema, obj[key], `${at}.${key}`)
      if (err) return err
    }
    return undefined
  }
  if (type === "array") {
    if (!Array.isArray(value)) return `${at} must be an array`
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        const err = validateArgs(schema.items, value[i], `${at}[${i}]`)
        if (err) return err
      }
    }
    return undefined
  }
  if (type === "string" && typeof value !== "string") return `${at} must be a string`
  if ((type === "number" || type === "integer") && typeof value !== "number") return `${at} must be a number`
  if (type === "boolean" && typeof value !== "boolean") return `${at} must be a boolean`
  return undefined
}

/** Models sometimes send numbers/booleans as strings; coerce the obvious cases in place. */
export function coerceArgs(schema: JSONSchema, value: any): any {
  if (!schema || typeof value !== "object" || value === null) return value
  for (const [key, sub] of Object.entries<JSONSchema>(schema.properties ?? {})) {
    const v = value[key]
    if (typeof v !== "string") continue
    if ((sub.type === "number" || sub.type === "integer") && v.trim() !== "" && !Number.isNaN(Number(v))) value[key] = Number(v)
    else if (sub.type === "boolean" && (v === "true" || v === "false")) value[key] = v === "true"
    else if (sub.type === "array" || sub.type === "object") {
      try {
        value[key] = JSON.parse(v)
      } catch {}
    }
  }
  return value
}
