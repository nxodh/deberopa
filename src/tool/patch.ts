import fs from "node:fs/promises"
import path from "node:path"
import { assertInsideProject, defineTool, resolvePath, ToolInputError, type ToolContext } from "./tool"
import { assertFresh, markRead } from "./filetime"
import { afterWrite, countChanges, unifiedDiff } from "./edit"
import { toPosix } from "../util/fs"

/** One file operation parsed from a patch. */
export type PatchOp =
  | { kind: "add"; path: string; content: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo?: string; hunks: Hunk[] }

export interface Hunk {
  /** Text after "@@", used to find the neighbourhood of the change. */
  header?: string
  lines: { op: " " | "-" | "+"; text: string }[]
  /** The hunk is anchored at the end of the file. */
  eof: boolean
}

const BEGIN = "*** Begin Patch"
const END = "*** End Patch"

export function parsePatch(text: string): PatchOp[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  let i = lines.findIndex((l) => l.trim() === BEGIN)
  if (i === -1) throw new ToolInputError(`The patch must start with "${BEGIN}" and end with "${END}".`)
  const ops: PatchOp[] = []
  i++
  let ended = false

  while (i < lines.length) {
    const line = lines[i]!
    if (line.trim() === END) {
      ended = true
      break
    }
    let m: RegExpExecArray | null
    if ((m = /^\*\*\* Add File: (.+)$/.exec(line))) {
      const content: string[] = []
      i++
      while (i < lines.length && !lines[i]!.startsWith("*** ")) {
        const l = lines[i]!
        if (!l.startsWith("+")) throw new ToolInputError(`Line ${i + 1}: every line of an added file must start with "+" (got: ${JSON.stringify(l.slice(0, 40))}).`)
        content.push(l.slice(1))
        i++
      }
      ops.push({ kind: "add", path: m[1]!.trim(), content: content.length ? content.join("\n") + "\n" : "" })
    } else if ((m = /^\*\*\* Delete File: (.+)$/.exec(line))) {
      ops.push({ kind: "delete", path: m[1]!.trim() })
      i++
    } else if ((m = /^\*\*\* Update File: (.+)$/.exec(line))) {
      const op: PatchOp = { kind: "update", path: m[1]!.trim(), hunks: [] }
      i++
      if (i < lines.length && /^\*\*\* Move to: (.+)$/.test(lines[i]!)) {
        op.moveTo = /^\*\*\* Move to: (.+)$/.exec(lines[i]!)![1]!.trim()
        i++
      }
      let hunk: Hunk | undefined
      while (i < lines.length && !/^\*\*\* (Add|Delete|Update) File:/.test(lines[i]!) && lines[i]!.trim() !== END) {
        const l = lines[i]!
        if (l.startsWith("@@")) {
          hunk = { header: l.slice(2).trim() || undefined, lines: [], eof: false }
          op.hunks.push(hunk)
        } else if (l.trim() === "*** End of File") {
          if (hunk) hunk.eof = true
        } else if (l.startsWith("*** ")) {
          throw new ToolInputError(`Line ${i + 1}: unexpected "${l.slice(0, 40)}" inside an Update File section.`)
        } else {
          // a hunk may start without an "@@" line
          if (!hunk) {
            hunk = { lines: [], eof: false }
            op.hunks.push(hunk)
          }
          const prefix = l[0]
          if (prefix === " " || prefix === "-" || prefix === "+") hunk.lines.push({ op: prefix, text: l.slice(1) })
          else if (l === "") hunk.lines.push({ op: " ", text: "" }) // editors strip the lone space of a blank context line
          else throw new ToolInputError(`Line ${i + 1}: hunk lines must start with " ", "-" or "+" (got: ${JSON.stringify(l.slice(0, 40))}).`)
        }
        i++
      }
      if (op.hunks.length === 0 && !op.moveTo) throw new ToolInputError(`Update File ${op.path} has no changes.`)
      ops.push(op)
    } else if (line.trim() === "") {
      i++
    } else {
      throw new ToolInputError(`Line ${i + 1}: expected a "*** Add File:", "*** Update File:" or "*** Delete File:" header (got: ${JSON.stringify(line.slice(0, 50))}).`)
    }
  }
  if (!ended) throw new ToolInputError(`The patch is missing its closing "${END}" line (it may have been cut off).`)
  if (ops.length === 0) throw new ToolInputError("The patch contains no file operations.")
  return ops
}

const fold = (s: string) =>
  s
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/ /g, " ")
    .trim()

const MATCHERS: ((a: string, b: string) => boolean)[] = [
  (a, b) => a === b,
  (a, b) => a.trimEnd() === b.trimEnd(),
  (a, b) => a.trim() === b.trim(),
  (a, b) => fold(a) === fold(b),
]

/** Index of `needle` within `hay` at or after `from`, trying progressively looser line comparisons. */
function findSequence(hay: string[], needle: string[], from: number, eof: boolean): number {
  if (needle.length === 0) return eof ? hay.length : from
  for (const same of MATCHERS) {
    if (eof) {
      const start = hay.length - needle.length
      if (start >= from && needle.every((n, j) => same(hay[start + j]!, n))) return start
    }
    for (let i = from; i + needle.length <= hay.length; i++) {
      if (needle.every((n, j) => same(hay[i + j]!, n))) return i
    }
  }
  return -1
}

export function applyHunks(original: string, hunks: Hunk[], file: string): string {
  const crlf = original.includes("\r\n")
  const normalized = crlf ? original.replace(/\r\n/g, "\n") : original
  const trailing = normalized.endsWith("\n")
  const lines = normalized === "" ? [] : (trailing ? normalized.slice(0, -1) : normalized).split("\n")
  let cursor = 0

  for (const [n, hunk] of hunks.entries()) {
    let from = cursor
    if (hunk.header) {
      const at = findSequence(lines, [hunk.header], cursor, false)
      if (at !== -1) from = at // the change itself follows the header line
    }
    const oldLines = hunk.lines.filter((l) => l.op !== "+").map((l) => l.text)
    const newLines = hunk.lines.filter((l) => l.op !== "-").map((l) => l.text)
    const at = findSequence(lines, oldLines, from, hunk.eof)
    if (at === -1) {
      const sample = oldLines.slice(0, 4).map((l) => `  ${l}`).join("\n")
      throw new ToolInputError(
        `Hunk ${n + 1} of ${file} does not match the file: these lines were not found${hunk.header ? ` after "${hunk.header}"` : ""}:\n${sample}\nRead the file again and copy the lines exactly, including indentation.`,
      )
    }
    lines.splice(at, oldLines.length, ...newLines)
    cursor = at + newLines.length
  }

  const body = lines.join("\n")
  const out = lines.length === 0 ? "" : body + (trailing || original === "" ? "\n" : "")
  return crlf ? out.replace(/\n/g, "\r\n") : out
}

interface Planned {
  op: PatchOp
  file: string
  target?: string
  before: string
  after: string | undefined
}

export const PatchTool = defineTool<{ patchText: string }>({
  id: "patch",
  description: `Applies a patch that can create, change, move and delete several files in one operation.

Prefer the edit tool for a single replacement. Use this when changing many files at once, or when you are working from a diff.

Format (the whole text must be wrapped in the Begin/End lines):

*** Begin Patch
*** Add File: path/new.txt
+first line
+second line
*** Update File: path/existing.ts
@@ function name or nearby line (optional)
 unchanged context line
-line to remove
+line to add
 unchanged context line
*** Update File: old/name.ts
*** Move to: new/name.ts
@@
-old
+new
*** Delete File: path/obsolete.txt
*** End Patch

Rules:
- Paths are relative to the working directory (absolute paths also work).
- Every hunk line starts with " " (unchanged), "-" (remove) or "+" (add). Give about three lines of unchanged context around each change.
- Context and removed lines must match the file; read the file first. Leading and trailing whitespace differences are tolerated.
- The patch is atomic: if any file fails to apply, nothing is written.`,
  parameters: {
    type: "object",
    required: ["patchText"],
    properties: { patchText: { type: "string", description: "The complete patch, from *** Begin Patch to *** End Patch" } },
  },
  async execute(args, ctx: ToolContext) {
    const ops = parsePatch(args.patchText)
    const planned: Planned[] = []
    const seen = new Set<string>()

    // 1. Work out every result in memory first so a failure leaves the tree untouched.
    for (const op of ops) {
      const file = resolvePath(ctx, op.path)
      await assertInsideProject(ctx, file)
      if (seen.has(file)) throw new ToolInputError(`${op.path} appears more than once in the patch. Combine the changes into one section.`)
      seen.add(file)
      const exists = await fs.stat(file).then((s) => (s.isDirectory() ? "dir" : "file"), () => undefined)
      if (exists === "dir") throw new ToolInputError(`${op.path} is a directory.`)

      if (op.kind === "add") {
        if (exists) throw new ToolInputError(`${op.path} already exists. Use "*** Update File:" to change it.`)
        planned.push({ op, file, before: "", after: op.content })
      } else if (op.kind === "delete") {
        if (!exists) throw new ToolInputError(`Cannot delete ${op.path}: it does not exist.`)
        await assertFresh(ctx.sessionID, file)
        planned.push({ op, file, before: await fs.readFile(file, "utf8"), after: undefined })
      } else {
        if (!exists) throw new ToolInputError(`Cannot update ${op.path}: it does not exist. Use "*** Add File:" to create it.`)
        await assertFresh(ctx.sessionID, file)
        const before = await fs.readFile(file, "utf8")
        const after = op.hunks.length ? applyHunks(before, op.hunks, op.path) : before
        let target: string | undefined
        if (op.moveTo) {
          target = resolvePath(ctx, op.moveTo)
          await assertInsideProject(ctx, target)
          if (await fs.stat(target).then(() => true, () => false)) throw new ToolInputError(`Cannot move ${op.path}: ${op.moveTo} already exists.`)
        }
        planned.push({ op, file, target, before, after })
      }
    }

    // 2. One permission request that shows the whole change.
    const rel = (f: string) => toPosix(path.relative(ctx.worktree, f) || f)
    const diffs = planned.map((p) => unifiedDiff(rel(p.target ?? p.file), p.before, p.after ?? ""))
    await ctx.ask({
      permission: "edit",
      patterns: planned.map((p) => rel(p.target ?? p.file)),
      always: ["*"],
      title: planned.length === 1 ? `Patch ${rel(planned[0]!.target ?? planned[0]!.file)}` : `Patch ${planned.length} files`,
      metadata: { diff: diffs.join("\n"), files: planned.map((p) => rel(p.file)) },
    })

    // 3. Write.
    const notes: string[] = []
    let additions = 0
    let deletions = 0
    for (const [i, p] of planned.entries()) {
      const c = countChanges(diffs[i]!)
      additions += c.additions
      deletions += c.deletions
      if (p.op.kind === "delete") {
        await fs.rm(p.file)
        notes.push(`deleted ${rel(p.file)}`)
        continue
      }
      const destination = p.target ?? p.file
      await fs.mkdir(path.dirname(destination), { recursive: true })
      await fs.writeFile(destination, p.after ?? "")
      if (p.target) await fs.rm(p.file)
      notes.push(`${p.op.kind === "add" ? "created" : p.target ? `moved to ${rel(destination)}` : "updated"} ${rel(p.op.kind === "update" && p.target ? p.file : destination)}`)
      const problems = await afterWrite(ctx, destination)
      if (problems) notes.push(problems.trim())
      else markRead(ctx.sessionID, destination)
    }
    return {
      title: planned.length === 1 ? rel(planned[0]!.target ?? planned[0]!.file) : `${planned.length} files`,
      output: `Patch applied:\n${notes.map((n) => `- ${n}`).join("\n")}`,
      metadata: { diff: diffs.join("\n"), additions, deletions, files: planned.map((p) => rel(p.target ?? p.file)) },
    }
  },
})
