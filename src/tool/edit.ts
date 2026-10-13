import fs from "node:fs/promises"
import path from "node:path"
import { createTwoFilesPatch } from "diff"
import { assertInsideProject, defineTool, resolvePath, ToolInputError, type ToolContext } from "./tool"
import { assertFresh, markRead } from "./filetime"
import { publish } from "../util/bus"
import { formatFile } from "../format/format"
import { formatDiagnostics, offerInstall, touchFile } from "../lsp"

/**
 * Find `find` in `content` and replace it. Models rarely reproduce whitespace perfectly, so after
 * an exact match fails we retry with progressively looser comparisons, always insisting that the
 * match is unambiguous.
 */
export function replace(content: string, find: string, replacement: string, replaceAll = false): string {
  if (find === replacement) throw new ToolInputError("oldString and newString must be different.")
  if (find === "") throw new ToolInputError("oldString must not be empty. To create a file use the write tool.")

  let ambiguous = false
  for (const strategy of [exact, lineTrimmed, indentationFlexible, whitespaceNormalized]) {
    const matches = strategy(content, find)
    if (matches.length === 0) continue
    if (replaceAll) {
      let result = content
      // right to left so earlier offsets stay valid
      for (const m of [...matches].sort((a, b) => b.start - a.start)) result = result.slice(0, m.start) + replacement + result.slice(m.end)
      return result
    }
    if (matches.length > 1) {
      ambiguous = true
      continue
    }
    const m = matches[0]!
    return content.slice(0, m.start) + replacement + content.slice(m.end)
  }
  if (ambiguous) {
    throw new ToolInputError(
      "Found multiple matches for oldString. Include more surrounding lines to make it unique, or set replaceAll to change every occurrence.",
    )
  }
  throw new ToolInputError(
    "oldString was not found in the file. It must match the file content exactly, including whitespace and indentation. Read the file again and copy the text precisely.",
  )
}

interface Match {
  start: number
  end: number
}

function exact(content: string, find: string): Match[] {
  const out: Match[] = []
  let index = content.indexOf(find)
  while (index !== -1) {
    out.push({ start: index, end: index + find.length })
    index = content.indexOf(find, index + find.length)
  }
  return out
}

/** Compare line by line with a normaliser, returning the spans of whole-line blocks that match. */
function lineBlocks(content: string, find: string, normalise: (line: string) => string, relativeIndent = false): Match[] {
  const contentLines = content.split("\n")
  const findLines = find.split("\n")
  if (findLines[findLines.length - 1] === "") findLines.pop()
  if (findLines.length === 0) return []
  const offsets: number[] = []
  let position = 0
  for (const line of contentLines) {
    offsets.push(position)
    position += line.length + 1
  }
  const strip = (lines: string[]) => {
    if (!relativeIndent) return lines.map(normalise)
    const indents = lines.filter((l) => l.trim() !== "").map((l) => l.length - l.trimStart().length)
    const min = indents.length ? Math.min(...indents) : 0
    return lines.map((l) => (l.trim() === "" ? "" : l.slice(min).replace(/\s+$/, "")))
  }
  const target = strip(findLines)
  const out: Match[] = []
  for (let i = 0; i + findLines.length <= contentLines.length; i++) {
    const window = strip(contentLines.slice(i, i + findLines.length))
    if (window.every((line, j) => line === target[j])) {
      const last = i + findLines.length - 1
      out.push({ start: offsets[i]!, end: offsets[last]! + contentLines[last]!.length })
    }
  }
  return out
}

const lineTrimmed = (content: string, find: string) => lineBlocks(content, find, (l) => l.trim())
const indentationFlexible = (content: string, find: string) => lineBlocks(content, find, (l) => l, true)
const whitespaceNormalized = (content: string, find: string) => lineBlocks(content, find, (l) => l.replace(/\s+/g, " ").trim())

export function unifiedDiff(file: string, before: string, after: string): string {
  return createTwoFilesPatch(file, file, before, after, "", "", { context: 3 })
    .split("\n")
    .slice(1) // drop the "Index:" style header line
    .join("\n")
}

export function countChanges(diff: string) {
  let additions = 0
  let deletions = 0
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++
  }
  return { additions, deletions }
}

/** Everything that happens after file content changes on disk: format, notify, collect diagnostics. */
export async function afterWrite(ctx: ToolContext, file: string): Promise<string> {
  await formatFile(file).catch(() => undefined)
  markRead(ctx.sessionID, file)
  publish("file.edited", { sessionID: ctx.sessionID, file })
  const note = await offerInstall(file, {
    ask: (request) => ctx.ask(request),
    progress: (message) => ctx.metadata({ title: message }),
    signal: ctx.abort,
  })
  await touchFile(file, true).catch(() => {})
  const problems = formatDiagnostics(file)
  const tail = problems ? `\n\nThis file has errors, please fix them:\n<diagnostics file="${file}">\n${problems}\n</diagnostics>` : ""
  return note ? `\n\n${note}${tail}` : tail
}

export interface EditArgs {
  filePath: string
  oldString: string
  newString: string
  replaceAll?: boolean
}

/** Apply one or more edits to a file's text, honouring its existing line endings. */
export function applyEdits(original: string, edits: { oldString: string; newString: string; replaceAll?: boolean }[]): string {
  const crlf = original.includes("\r\n")
  let content = crlf ? original.replace(/\r\n/g, "\n") : original
  for (const edit of edits) {
    content = replace(content, edit.oldString.replace(/\r\n/g, "\n"), edit.newString.replace(/\r\n/g, "\n"), edit.replaceAll)
  }
  return crlf ? content.replace(/\n/g, "\r\n") : content
}

export const EditTool = defineTool<EditArgs>({
  id: "edit",
  description: `Performs exact string replacements in files.

Usage:
- You must read the file with the read tool at least once in this conversation before editing it. The edit fails otherwise.
- When copying text from read output, preserve the exact indentation as it appears AFTER the line number prefix ("00012| "). Never include any part of the prefix in oldString or newString.
- The edit fails if oldString is not found, or if it matches more than once. Add surrounding lines to make it unique, or use replaceAll to change every occurrence (useful for renaming).
- Prefer editing existing files over creating new ones. Keep edits minimal and focused.
- To make several changes to one file, prefer the multiedit tool.`,
  parameters: {
    type: "object",
    required: ["filePath", "oldString", "newString"],
    properties: {
      filePath: { type: "string", description: "Path of the file to modify" },
      oldString: { type: "string", description: "The text to replace" },
      newString: { type: "string", description: "The text to replace it with (must differ from oldString)" },
      replaceAll: { type: "boolean", description: "Replace every occurrence of oldString (default false)" },
    },
  },
  async execute(args, ctx) {
    const file = resolvePath(ctx, args.filePath)
    const title = path.relative(ctx.worktree, file) || file
    await assertInsideProject(ctx, file)

    const stat = await fs.stat(file).catch(() => undefined)
    if (!stat) throw new ToolInputError(`File not found: ${file}. Use the write tool to create new files.`)
    if (stat.isDirectory()) throw new ToolInputError(`${file} is a directory, not a file.`)
    await assertFresh(ctx.sessionID, file)

    const before = await fs.readFile(file, "utf8")
    const after = applyEdits(before, [args])
    const diff = unifiedDiff(title, before, after)
    await ctx.ask({ permission: "edit", patterns: [title], always: ["*"], title: `Edit ${title}`, metadata: { path: file, diff } })

    await fs.writeFile(file, after)
    const diagnostics = await afterWrite(ctx, file)
    return { title, output: "Edit applied successfully." + diagnostics, metadata: { diff, ...countChanges(diff), path: file } }
  },
})

export const MultiEditTool = defineTool<{ filePath: string; edits: { oldString: string; newString: string; replaceAll?: boolean }[] }>({
  id: "multiedit",
  description: `Makes several edits to a single file in one operation. Prefer this over repeated edit calls when changing multiple parts of the same file.

Usage:
- Read the file first. Each edit follows the same rules as the edit tool (exact, unique oldString unless replaceAll is set).
- Edits are applied in order, each one operating on the result of the previous edit.
- The operation is atomic: if any edit fails, none are applied.
- Plan the sequence so an earlier edit does not change text a later edit needs to find.`,
  parameters: {
    type: "object",
    required: ["filePath", "edits"],
    properties: {
      filePath: { type: "string", description: "Path of the file to modify" },
      edits: {
        type: "array",
        description: "Edits to apply sequentially",
        items: {
          type: "object",
          required: ["oldString", "newString"],
          properties: {
            oldString: { type: "string", description: "The text to replace" },
            newString: { type: "string", description: "The text to replace it with" },
            replaceAll: { type: "boolean", description: "Replace every occurrence (default false)" },
          },
        },
      },
    },
  },
  async execute(args, ctx) {
    if (!args.edits.length) throw new ToolInputError("edits must contain at least one edit.")
    const file = resolvePath(ctx, args.filePath)
    const title = path.relative(ctx.worktree, file) || file
    await assertInsideProject(ctx, file)
    const stat = await fs.stat(file).catch(() => undefined)
    if (!stat) throw new ToolInputError(`File not found: ${file}. Use the write tool to create new files.`)
    await assertFresh(ctx.sessionID, file)

    const before = await fs.readFile(file, "utf8")
    let after: string
    try {
      after = applyEdits(before, args.edits)
    } catch (err) {
      throw new ToolInputError(`No edits were applied. ${err instanceof Error ? err.message : String(err)}`)
    }
    const diff = unifiedDiff(title, before, after)
    await ctx.ask({ permission: "edit", patterns: [title], always: ["*"], title: `Edit ${title}`, metadata: { path: file, diff } })

    await fs.writeFile(file, after)
    const diagnostics = await afterWrite(ctx, file)
    return {
      title,
      output: `Applied ${args.edits.length} edit${args.edits.length === 1 ? "" : "s"} successfully.` + diagnostics,
      metadata: { diff, ...countChanges(diff), path: file },
    }
  },
})

export const WriteTool = defineTool<{ filePath: string; content: string }>({
  id: "write",
  description: `Writes a file to the local filesystem, creating parent directories as needed.

Usage:
- This overwrites the file if it already exists. For an existing file you must read it first; the write fails otherwise.
- Prefer the edit tool for changing existing files: it only sends the difference.
- Do not create documentation files (README, *.md) unless the user asked for them.`,
  parameters: {
    type: "object",
    required: ["filePath", "content"],
    properties: {
      filePath: { type: "string", description: "Path of the file to write" },
      content: { type: "string", description: "The complete content of the file" },
    },
  },
  async execute(args, ctx) {
    const file = resolvePath(ctx, args.filePath)
    const title = path.relative(ctx.worktree, file) || file
    await assertInsideProject(ctx, file)

    const stat = await fs.stat(file).catch(() => undefined)
    if (stat?.isDirectory()) throw new ToolInputError(`${file} is a directory, not a file.`)
    let before = ""
    if (stat) {
      await assertFresh(ctx.sessionID, file)
      before = await fs.readFile(file, "utf8")
    }
    // Keep CRLF files CRLF: the model writes \n, the file's convention wins.
    const content = before.includes("\r\n") ? args.content.replace(/\r?\n/g, "\r\n") : args.content
    const diff = unifiedDiff(title, before, content)
    await ctx.ask({
      permission: "edit",
      patterns: [title],
      always: ["*"],
      title: `${stat ? "Overwrite" : "Create"} ${title}`,
      metadata: { path: file, diff },
    })

    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, content)
    const diagnostics = await afterWrite(ctx, file)
    return {
      title,
      output: (stat ? "File overwritten successfully." : "File created successfully.") + diagnostics,
      metadata: { diff, ...countChanges(diff), path: file, created: !stat },
    }
  },
})
