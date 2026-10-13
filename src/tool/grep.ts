import fs from "node:fs/promises"
import { walk } from "../util/walk"
import { globMatcher } from "./glob"
import { assertInsideProject, defineTool, resolvePath, ToolInputError } from "./tool"

const MAX_MATCHES = 100
const MAX_LINE_CHARS = 500
const MAX_FILE_BYTES = 2 * 1024 * 1024
/** A NUL byte in this prefix marks the file as binary. */
const BINARY_PROBE_BYTES = 8000
const TRUNCATED_NOTE = "(Results are truncated. Consider using a more specific path or pattern.)"

interface GrepArgs {
  pattern: string
  path?: string
  include?: string
  ignore_case?: boolean
}

interface Candidate {
  abs: string
  mtime: number
  size: number
}

interface FileHits {
  file: string
  lines: { no: number; text: string }[]
}

export const GrepTool = defineTool<GrepArgs>({
  id: "grep",
  description: [
    "Searches file contents with a regular expression and returns matching lines grouped by file, most recently modified files first.",
    "Use it to find where a symbol, string or pattern is used, e.g. `function loadConfig` or `TODO\\(.*\\)`.",
    'Use include to limit the search to certain file names ("*.ts", "*.{ts,tsx}") and ignore_case for case-insensitive matching.',
    "Binary files and files over 2 MB are skipped; .gitignore rules and node_modules are respected.",
    "Returns at most 100 matching lines; narrow the path or pattern when the result is truncated.",
    "To find files by name rather than content, use glob. If you need to count matches or find lines within one known file, prefer this over running shell commands.",
  ].join("\n"),
  parameters: {
    type: "object",
    required: ["pattern"],
    properties: {
      pattern: {
        type: "string",
        description: "Regular expression to search for in file contents.",
      },
      path: {
        type: "string",
        description: "File or directory to search. Defaults to the session directory.",
      },
      include: {
        type: "string",
        description: 'Only search files whose name matches this glob, e.g. "*.ts" or "*.{ts,tsx}". Ignored when path is a single file.',
      },
      ignore_case: {
        type: "boolean",
        description: "Match case-insensitively. Defaults to false.",
      },
    },
  },
  async execute({ pattern, path: target, include, ignore_case }, ctx) {
    let regex: RegExp
    try {
      regex = new RegExp(pattern, ignore_case ? "i" : "")
    } catch (err) {
      throw new ToolInputError(`Invalid regular expression: ${(err as Error).message}`)
    }

    const searchPath = target ? resolvePath(ctx, target) : ctx.directory
    const info = await fs.stat(searchPath).catch(() => undefined)
    if (!info) throw new ToolInputError(`Path not found: ${searchPath}`)
    await assertInsideProject(ctx, searchPath, info.isDirectory() ? "directory" : "file")

    const candidates: Candidate[] = []
    if (info.isDirectory()) {
      const nameFilter = include ? globMatcher(include) : undefined
      for await (const file of walk({ cwd: searchPath, signal: ctx.abort })) {
        ctx.abort.throwIfAborted()
        if (nameFilter && !nameFilter(file.rel)) continue
        const st = await fs.stat(file.path).catch(() => undefined)
        if (st?.isFile()) candidates.push({ abs: file.path, mtime: st.mtimeMs, size: st.size })
      }
    } else {
      candidates.push({ abs: searchPath, mtime: info.mtimeMs, size: info.size })
    }

    // Newest files first, so when the match cap is hit the most recently touched code wins.
    candidates.sort((a, b) => b.mtime - a.mtime)

    const groups: FileHits[] = []
    let total = 0
    let truncated = false
    for (const candidate of candidates) {
      ctx.abort.throwIfAborted()
      if (candidate.size > MAX_FILE_BYTES) continue
      const buf = await fs.readFile(candidate.abs).catch(() => undefined)
      if (!buf || buf.subarray(0, BINARY_PROBE_BYTES).includes(0)) continue

      const hits: { no: number; text: string }[] = []
      const rawLines = buf.toString("utf8").split("\n")
      for (let i = 0; i < rawLines.length; i++) {
        const raw = rawLines[i]!
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
        if (!regex.test(line)) continue
        if (total === MAX_MATCHES) {
          // One match past the cap: there is more to report, so flag truncation and stop.
          truncated = true
          break
        }
        total++
        hits.push({ no: i + 1, text: line.slice(0, MAX_LINE_CHARS) })
      }
      if (hits.length > 0) groups.push({ file: candidate.abs, lines: hits })
      if (truncated) break
    }

    if (total === 0) {
      return { title: pattern, output: "No files found", metadata: { matches: 0, truncated: false } }
    }

    const blocks = groups.map((g) => [`${g.file}:`, ...g.lines.map((l) => `  Line ${l.no}: ${l.text}`)].join("\n"))
    let output = `Found ${total} matches\n${blocks.join("\n\n")}`
    if (truncated) output += `\n${TRUNCATED_NOTE}`

    return { title: pattern, output, metadata: { matches: total, truncated } }
  },
})
