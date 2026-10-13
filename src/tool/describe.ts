import path from "node:path"
import { project } from "../project"
import type { ToolPart } from "../session/message"

/** One-line description of a tool call for transcripts and logs: `{ name, detail }`. */
export function describeTool(part: ToolPart): { name: string; detail: string } {
  const input = (part.state.input ?? {}) as Record<string, any>
  const rel = (p: unknown) => {
    if (typeof p !== "string" || !p) return ""
    const base = project().directory
    const r = path.relative(base, p)
    return r && !r.startsWith("..") && !path.isAbsolute(r) ? r.split(path.sep).join("/") : p
  }
  const title = part.state.status === "completed" || part.state.status === "running" ? part.state.title : undefined
  switch (part.tool) {
    case "bash":
      return { name: "bash", detail: String(title && title !== input.command ? title : (input.command ?? "")) }
    case "read":
      return { name: "read", detail: rel(input.filePath) }
    case "edit":
    case "multiedit":
      return { name: "edit", detail: rel(input.filePath) }
    case "write":
      return { name: "write", detail: rel(input.filePath) }
    case "websearch":
      return { name: "websearch", detail: String(input.query ?? "") }
    case "patch":
      return { name: "patch", detail: String(title ?? "") }
    case "glob":
      return { name: "glob", detail: String(input.pattern ?? "") + (input.path ? `  in ${rel(input.path)}` : "") }
    case "grep":
      return { name: "grep", detail: String(input.pattern ?? "") + (input.include ? `  (${input.include})` : "") }
    case "list":
      return { name: "list", detail: rel(input.path) || "." }
    case "webfetch":
      return { name: "fetch", detail: String(input.url ?? "") }
    case "todowrite":
    case "todoread":
      return { name: "todo", detail: title ?? "" }
    case "task":
      return { name: "task", detail: `${input.subagent_type ?? ""}: ${input.description ?? ""}`.trim() }
    case "skill":
      return { name: "skill", detail: String(input.name ?? "") }
    default:
      return { name: part.tool, detail: title ?? "" }
  }
}

export function compactJSON(value: unknown, max = 120): string {
  let text: string
  try {
    text = JSON.stringify(value)
  } catch {
    text = String(value)
  }
  return text.length > max ? text.slice(0, max - 1) + "…" : text
}
