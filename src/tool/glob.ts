import fs from "node:fs/promises"
import path from "node:path"
import { toPosix } from "../util/fs"
import { walk } from "../util/walk"
import { assertInsideProject, defineTool, resolvePath, ToolInputError } from "./tool"

const MAX_RESULTS = 100
const TRUNCATED_NOTE = "(Results are truncated. Consider using a more specific path or pattern.)"

/**
 * Matches a posix path relative to the search root. A pattern without a slash is matched
 * against the file name only, so `*.ts` finds files at any depth.
 */
export function globMatcher(pattern: string): (rel: string) => boolean {
  const glob = new Bun.Glob(pattern)
  const nameOnly = !pattern.includes("/")
  return (rel) => {
    if (glob.match(rel)) return true
    return nameOnly && glob.match(rel.slice(rel.lastIndexOf("/") + 1))
  }
}

interface GlobArgs {
  pattern: string
  path?: string
}

export const GlobTool = defineTool<GlobArgs>({
  id: "glob",
  description: [
    "Finds files by name or glob pattern and returns their absolute paths, most recently modified first.",
    "Use it to locate files when you know part of the name or extension, e.g. `**/*.test.ts` or `package.json`.",
    "A pattern without a slash matches the file name at any depth, so `*.ts` finds every TypeScript file below the search directory.",
    "Respects .gitignore and skips node_modules, .git and build output.",
    "Returns at most 100 results; narrow the path or pattern when the result is truncated.",
    "To search file contents instead of names, use grep.",
  ].join("\n"),
  parameters: {
    type: "object",
    required: ["pattern"],
    properties: {
      pattern: {
        type: "string",
        description: 'Glob pattern to match, e.g. "**/*.ts", "src/*.json" or "*.md".',
      },
      path: {
        type: "string",
        description: "Directory to search. Defaults to the session directory.",
      },
    },
  },
  async execute({ pattern, path: dirInput }, ctx) {
    const dir = dirInput ? resolvePath(ctx, dirInput) : ctx.directory
    await assertInsideProject(ctx, dir, "directory")
    const info = await fs.stat(dir).catch(() => undefined)
    if (!info?.isDirectory()) throw new ToolInputError(`Directory not found: ${dir}`)

    const match = globMatcher(pattern)
    const hits: { abs: string; mtime: number }[] = []
    for await (const file of walk({ cwd: dir, signal: ctx.abort })) {
      ctx.abort.throwIfAborted()
      if (!match(file.rel)) continue
      const st = await fs.stat(file.path).catch(() => undefined)
      if (st) hits.push({ abs: file.path, mtime: st.mtimeMs })
    }

    hits.sort((a, b) => b.mtime - a.mtime)
    const truncated = hits.length > MAX_RESULTS
    const shown = hits.slice(0, MAX_RESULTS)
    const lines = shown.map((h) => h.abs)
    if (lines.length === 0) lines.push("No files found")
    if (truncated) lines.push(TRUNCATED_NOTE)

    return {
      title: toPosix(path.relative(ctx.worktree, dir)) || ".",
      output: lines.join("\n"),
      metadata: { count: shown.length, truncated },
    }
  },
})
