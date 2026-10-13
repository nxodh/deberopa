import fs from "node:fs/promises"
import path from "node:path"
import { assertInsideProject, defineTool, resolvePath, ToolInputError } from "./tool"
import { markRead } from "./filetime"

const DEFAULT_LIMIT = 2000
const MAX_LINE_LENGTH = 2000
const MAX_BYTES = 50 * 1024
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
}

const BINARY_EXTENSIONS = new Set([
  ".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".exe", ".dll", ".so", ".dylib", ".a", ".o", ".obj", ".class", ".jar", ".war",
  ".bin", ".dat", ".db", ".sqlite", ".wasm", ".pyc", ".pyo", ".ico", ".bmp", ".tiff", ".mp3", ".mp4", ".mov", ".avi", ".mkv", ".wav", ".flac",
  ".ogg", ".woff", ".woff2", ".ttf", ".otf", ".eot", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".psd", ".iso", ".dmg",
])

async function looksBinary(file: string, size: number): Promise<boolean> {
  if (BINARY_EXTENSIONS.has(path.extname(file).toLowerCase())) return true
  if (size === 0) return false
  const handle = await fs.open(file, "r")
  try {
    const buffer = Buffer.alloc(Math.min(4096, size))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    let odd = 0
    for (let i = 0; i < bytesRead; i++) {
      const byte = buffer[i]!
      if (byte === 0) return true
      if (byte < 9 || (byte > 13 && byte < 32)) odd++
    }
    return bytesRead > 0 && odd / bytesRead > 0.3
  } finally {
    await handle.close()
  }
}

export const ReadTool = defineTool<{ filePath: string; offset?: number; limit?: number }>({
  id: "read",
  description: `Reads a file from the local filesystem.

Usage:
- filePath should be an absolute path; relative paths resolve against the working directory.
- By default it returns up to ${DEFAULT_LIMIT} lines from the start of the file. For long files pass offset (1-based line number) and limit to read a specific window.
- Lines longer than ${MAX_LINE_LENGTH} characters are truncated.
- Output is prefixed with line numbers in the form "00001| content". The prefix is not part of the file: never include it when editing.
- Images (png, jpg, gif, webp) and PDFs are returned as attachments you can look at.
- This tool reads files, not directories. Use the list tool for directories.
- Read several files in one turn by making multiple read calls in parallel.
- You must read a file with this tool before editing or overwriting it.`,
  parameters: {
    type: "object",
    required: ["filePath"],
    properties: {
      filePath: { type: "string", description: "Path of the file to read" },
      offset: { type: "number", description: "1-based line number to start reading from" },
      limit: { type: "number", description: `Maximum number of lines to read (default ${DEFAULT_LIMIT})` },
    },
  },
  async execute(args, ctx) {
    const file = resolvePath(ctx, args.filePath)
    const title = path.relative(ctx.worktree, file) || file
    await assertInsideProject(ctx, file)
    await ctx.ask({ permission: "read", patterns: [file], always: ["*"], title: `Read ${title}`, metadata: { path: file } })

    const stat = await fs.stat(file).catch(() => undefined)
    if (!stat) {
      const dir = path.dirname(file)
      const base = path.basename(file).toLowerCase()
      const siblings = await fs.readdir(dir).catch(() => [] as string[])
      const similar = siblings
        .filter((name) => name.toLowerCase().includes(base) || base.includes(name.toLowerCase()))
        .slice(0, 3)
        .map((name) => path.join(dir, name))
      throw new ToolInputError(
        similar.length ? `File not found: ${file}\n\nDid you mean one of these?\n${similar.join("\n")}` : `File not found: ${file}`,
      )
    }
    if (stat.isDirectory()) throw new ToolInputError(`${file} is a directory. Use the list tool to see its contents.`)

    const mime = IMAGE_TYPES[path.extname(file).toLowerCase()]
    if (mime) {
      if (stat.size > MAX_IMAGE_BYTES) throw new ToolInputError(`${file} is too large to attach (${stat.size} bytes, limit ${MAX_IMAGE_BYTES}).`)
      const data = await fs.readFile(file)
      markRead(ctx.sessionID, file)
      return {
        title,
        output: mime === "application/pdf" ? "PDF read successfully" : "Image read successfully",
        metadata: { preview: "", truncated: false },
        attachments: [{ mime, filename: path.basename(file), data: data.toString("base64") }],
      }
    }

    if (await looksBinary(file, stat.size)) throw new ToolInputError(`Cannot read binary file: ${file}`)

    const text = (await fs.readFile(file, "utf8")).replace(/^﻿/, "")
    const lines = text.split("\n")
    // a trailing newline is not an extra empty line
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop()
    const offset = Math.max(1, Math.floor(args.offset ?? 1))
    const limit = Math.max(1, Math.floor(args.limit ?? DEFAULT_LIMIT))
    if (offset > lines.length && lines.length > 0) {
      throw new ToolInputError(`Offset ${offset} is beyond the end of the file (${lines.length} lines).`)
    }

    const out: string[] = []
    let bytes = 0
    let cutByBytes = false
    for (let i = offset - 1; i < Math.min(lines.length, offset - 1 + limit); i++) {
      let line = (lines[i] ?? "").replace(/\r$/, "")
      if (line.length > MAX_LINE_LENGTH) line = line.slice(0, MAX_LINE_LENGTH) + "..."
      const size = Buffer.byteLength(line, "utf8") + 8
      if (bytes + size > MAX_BYTES && out.length > 0) {
        cutByBytes = true
        break
      }
      bytes += size
      out.push(`${String(i + 1).padStart(5, "0")}| ${line}`)
    }

    const lastLine = offset - 1 + out.length
    const more = lastLine < lines.length
    let output = "<file>\n" + out.join("\n")
    if (more) {
      output += `\n\n(${cutByBytes ? "Output truncated by size. " : ""}File has more lines: showing ${offset}-${lastLine} of ${lines.length}. Use offset=${lastLine + 1} to continue.)`
    } else output += `\n\n(End of file - total ${lines.length} lines)`
    output += "\n</file>"

    markRead(ctx.sessionID, file)
    return { title, output, metadata: { preview: out.slice(0, 20).join("\n"), truncated: more, lines: lines.length } }
  },
})
