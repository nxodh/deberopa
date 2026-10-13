import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { toPosix } from "../src/util/fs"
import { listFiles, walk } from "../src/util/walk"
import { GlobTool } from "../src/tool/glob"
import { GrepTool } from "../src/tool/grep"
import { ListTool } from "../src/tool/list"
import { ToolInputError, type PermissionRequest, type ToolContext } from "../src/tool/tool"

let root: string
let outside: string
const asked: PermissionRequest[] = []

function write(rel: string, data: string | Buffer) {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, data)
  return abs
}

function makeCtx(dir: string): ToolContext {
  return {
    sessionID: "s",
    messageID: "m",
    callID: "c",
    agent: "build",
    abort: new AbortController().signal,
    directory: dir,
    worktree: root,
    ask: async (req) => {
      asked.push(req)
    },
    metadata: () => {},
  }
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "vdc-"))
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "vdc-out-"))

  write(".gitignore", "*.log\nsecret/\n")
  write(".ignore", "scratch.tmp\n")
  write(".git/info/exclude", "excluded-by-info.txt\n")
  write("a.ts", "export const a = 1\n")
  write("debug.log", "log\n")
  write("scratch.tmp", "tmp\n")
  write("excluded-by-info.txt", "x\n")
  write("draft.md", "root draft\n")
  write("src/index.ts", "export {}\n")
  write("src/util/fs.ts", "export const fs = 1\n")
  write("docs/.gitignore", "draft.md\n")
  write("docs/draft.md", "nested draft\n")
  write("docs/guide.md", "guide\n")
  write("node_modules/pkg/index.js", "module.exports = {}\n")
  write("build/out.js", "built\n")
  write("secret/key.txt", "shh\n")
  write(".hidden/file.txt", "dot\n")

  // Binary: NUL byte in the probe window, but the text after it would match "needle".
  write("grepme/bin.dat", Buffer.concat([Buffer.from([0x00]), Buffer.from("needle\n")]))
  write("grepme/a.txt", "alpha\nbeta needle\ngamma\nneedle end\n")
  write("grepme/b.md", "no match here\nNEEDLE upper\nneedle lower\n")

  write("long/long.txt", `longneedle${"y".repeat(800)}\n`)

  const hits = Array.from({ length: 150 }, (_, i) => `hit ${i}`).join("\n")
  write("hits/hits.txt", hits)

  const big = Buffer.alloc(2 * 1024 * 1024 + 1, "a")
  big.write("needle", 0)
  write("big/big.txt", big)

  for (let i = 0; i < 105; i++) write(`many/f${String(i).padStart(3, "0")}.txt`, `${i}\n`)

  const oldFile = write("mtime/old.txt", "old\n")
  write("mtime/new.txt", "new\n")
  const past = new Date("2001-01-01T00:00:00Z")
  fs.utimesSync(oldFile, past, past)

  write("tree/src/index.ts", "x\n")
  write("tree/src/util/fs.ts", "x\n")
  write("tree/package.json", "{}\n")
  write("tree/readme.md", "x\n")
  write("tree/debug.log", "x\n")

  const many2 = Array.from({ length: 105 }, (_, i) => `t${String(i).padStart(3, "0")}.txt`)
  for (const name of many2) write(`many2/${name}`, "x\n")

  fs.writeFileSync(path.join(outside, "x.txt"), "outside\n")
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})

// walk / listFiles

test("walk honors root and nested ignore files and built-in skips", async () => {
  const files = await listFiles({ cwd: root })
  expect(files).toContain("a.ts")
  expect(files).toContain("src/util/fs.ts")
  expect(files).toContain("draft.md")
  expect(files).toContain("docs/guide.md")
  expect(files).toContain(".hidden/file.txt")
  // root .gitignore, .ignore, and .git/info/exclude
  expect(files).not.toContain("debug.log")
  expect(files).not.toContain("scratch.tmp")
  expect(files).not.toContain("excluded-by-info.txt")
  expect(files).not.toContain("secret/key.txt")
  // built-in skip list
  expect(files.some((f) => f.startsWith("node_modules/"))).toBe(false)
  // build output is only hidden when .gitignore says so (a real src/build dir must stay visible)
  expect(files).toContain("build/out.js")
  expect(files.some((f) => f.startsWith(".git/"))).toBe(false)
})

test("nested .gitignore applies only inside its directory", async () => {
  const files = await listFiles({ cwd: root })
  expect(files).not.toContain("docs/draft.md")
  expect(files).toContain("draft.md")
})

test("respectIgnore false yields ignored files and directories too", async () => {
  const files = await listFiles({ cwd: root, respectIgnore: false })
  expect(files).toContain("debug.log")
  expect(files).toContain("scratch.tmp")
  expect(files).toContain("excluded-by-info.txt")
  expect(files).toContain("secret/key.txt")
  expect(files).toContain("docs/draft.md")
  expect(files).toContain("node_modules/pkg/index.js")
  expect(files).toContain("build/out.js")
})

test("hidden false drops dotfiles and dot directories", async () => {
  const files = await listFiles({ cwd: root, hidden: false })
  expect(files).not.toContain(".hidden/file.txt")
  expect(files).not.toContain(".gitignore")
  expect(files).toContain("a.ts")
})

test("extraIgnore applies even when respectIgnore is false", async () => {
  const files = await listFiles({ cwd: root, respectIgnore: false, extraIgnore: ["*.ts"] })
  expect(files).not.toContain("a.ts")
  expect(files).not.toContain("src/index.ts")
  expect(files).toContain("debug.log")
})

test("walk yields absolute paths and posix relative paths", async () => {
  const seen: { path: string; rel: string }[] = []
  for await (const entry of walk({ cwd: root, limit: 1 })) seen.push(entry)
  expect(seen).toHaveLength(1)
  expect(path.isAbsolute(seen[0]!.path)).toBe(true)
  expect(path.join(root, seen[0]!.rel)).toBe(seen[0]!.path)
  expect(seen[0]!.rel.includes("\\")).toBe(false)
})

test("walk respects limit and abort signal", async () => {
  expect(await listFiles({ cwd: root, limit: 3 })).toHaveLength(3)
  const ac = new AbortController()
  ac.abort()
  expect(await listFiles({ cwd: root, signal: ac.signal })).toEqual([])
})

// glob

test("glob matches a bare extension at any depth", async () => {
  const ctx = makeCtx(root)
  const result = await GlobTool.execute({ pattern: "*.ts" }, ctx)
  const lines = result.output.split("\n")
  expect(lines).toContain(path.join(root, "a.ts"))
  expect(lines).toContain(path.join(root, "src", "index.ts"))
  expect(lines).toContain(path.join(root, "src", "util", "fs.ts"))
  expect(lines.some((l) => l.includes("node_modules"))).toBe(false)
})

test("glob with a slash matches the full relative path only", async () => {
  const ctx = makeCtx(root)
  const result = await GlobTool.execute({ pattern: "src/*.ts" }, ctx)
  const lines = result.output.split("\n")
  expect(lines).toEqual([path.join(root, "src", "index.ts")])
})

test("glob ** pattern and title", async () => {
  const ctx = makeCtx(root)
  const result = await GlobTool.execute({ pattern: "**/*.md", path: "docs" }, ctx)
  expect(result.output.split("\n")).toEqual([path.join(root, "docs", "guide.md")])
  expect(result.title).toBe("docs")
  expect(result.metadata).toEqual({ count: 1, truncated: false })
})

test("glob sorts newest first", async () => {
  const ctx = makeCtx(root)
  const result = await GlobTool.execute({ pattern: "*.txt", path: "mtime" }, ctx)
  expect(result.output.split("\n")[0]).toBe(path.join(root, "mtime", "new.txt"))
})

test("glob reports no files", async () => {
  const ctx = makeCtx(root)
  const result = await GlobTool.execute({ pattern: "*.nope" }, ctx)
  expect(result.output).toBe("No files found")
  expect(result.metadata).toEqual({ count: 0, truncated: false })
})

test("glob truncates at 100 results with a note", async () => {
  const ctx = makeCtx(root)
  const result = await GlobTool.execute({ pattern: "many/*.txt" }, ctx)
  const lines = result.output.split("\n")
  expect(lines).toHaveLength(101)
  expect(lines[100]).toBe("(Results are truncated. Consider using a more specific path or pattern.)")
  expect(result.metadata).toEqual({ count: 100, truncated: true })
})

test("glob asks permission for directories outside the project", async () => {
  asked.length = 0
  const ctx = makeCtx(root)
  const result = await GlobTool.execute({ pattern: "*.txt", path: outside }, ctx)
  expect(asked.some((r) => r.permission === "external_directory")).toBe(true)
  expect(result.output).toContain(path.join(outside, "x.txt"))
})

// grep

test("grep groups matches by file with line numbers", async () => {
  const ctx = makeCtx(root)
  const result = await GrepTool.execute({ pattern: "needle", path: "grepme" }, ctx)
  expect(result.output).toContain("Found 3 matches")
  expect(result.output).toContain(`${path.join(root, "grepme", "a.txt")}:\n  Line 2: beta needle\n  Line 4: needle end`)
  expect(result.output).toContain(`${path.join(root, "grepme", "b.md")}:\n  Line 3: needle lower`)
  expect(result.title).toBe("needle")
  expect(result.metadata).toEqual({ matches: 3, truncated: false })
})

test("grep is case-sensitive unless ignore_case is set", async () => {
  const ctx = makeCtx(root)
  const insensitive = await GrepTool.execute({ pattern: "needle", path: "grepme", ignore_case: true }, ctx)
  expect(insensitive.output).toContain("Found 4 matches")
  expect(insensitive.output).toContain("  Line 2: NEEDLE upper")
})

test("grep include filters by file name", async () => {
  const ctx = makeCtx(root)
  const md = await GrepTool.execute({ pattern: "needle", path: "grepme", include: "*.md" }, ctx)
  expect(md.output).toContain("Found 1 matches")
  expect(md.output).toContain(path.join("grepme", "b.md"))
  expect(md.output).not.toContain("a.txt")

  const brace = await GrepTool.execute({ pattern: "needle", path: "grepme", include: "*.{txt,md}" }, ctx)
  expect(brace.output).toContain("Found 3 matches")
})

test("grep rejects invalid regular expressions", async () => {
  const ctx = makeCtx(root)
  const err = await GrepTool.execute({ pattern: "(" }, ctx).catch((e: unknown) => e)
  expect(err).toBeInstanceOf(ToolInputError)
  expect((err as Error).message.startsWith("Invalid regular expression")).toBe(true)
})

test("grep skips binary files", async () => {
  const ctx = makeCtx(root)
  const result = await GrepTool.execute({ pattern: "needle", path: "grepme" }, ctx)
  expect(result.output).not.toContain("bin.dat")
})

test("grep skips files over 2 MB", async () => {
  const ctx = makeCtx(root)
  const result = await GrepTool.execute({ pattern: "needle", path: "big" }, ctx)
  expect(result.output).toBe("No files found")
})

test("grep reports no matches", async () => {
  const ctx = makeCtx(root)
  const result = await GrepTool.execute({ pattern: "zzz_absent", path: "grepme" }, ctx)
  expect(result.output).toBe("No files found")
})

test("grep accepts a single file path", async () => {
  const ctx = makeCtx(root)
  const result = await GrepTool.execute({ pattern: "needle", path: "grepme/a.txt" }, ctx)
  expect(result.output).toContain("Found 2 matches")
  expect(result.output).toContain(`${path.join(root, "grepme", "a.txt")}:`)
})

test("grep trims long lines to 500 characters", async () => {
  const ctx = makeCtx(root)
  const result = await GrepTool.execute({ pattern: "longneedle", path: "long" }, ctx)
  const line = result.output.split("\n").find((l) => l.startsWith("  Line 1: "))!
  expect(line.length).toBe("  Line 1: ".length + 500)
})

test("grep caps matches at 100 with a truncation note", async () => {
  const ctx = makeCtx(root)
  const result = await GrepTool.execute({ pattern: "hit", path: "hits" }, ctx)
  const lines = result.output.split("\n")
  expect(lines.filter((l) => l.startsWith("  Line ")).length).toBe(100)
  expect(lines[lines.length - 1]).toBe("(Results are truncated. Consider using a more specific path or pattern.)")
  expect(result.metadata).toEqual({ matches: 100, truncated: true })
})

// list

test("list renders a directory-first tree with absolute header", async () => {
  const ctx = makeCtx(root)
  const result = await ListTool.execute({ path: "tree", ignore: ["*.log"] }, ctx)
  expect(result.output).toBe(
    [
      `${toPosix(path.join(root, "tree"))}/`,
      "  src/",
      "    util/",
      "      fs.ts",
      "    index.ts",
      "  package.json",
      "  readme.md",
    ].join("\n"),
  )
  expect(result.title).toBe("tree")
  expect(result.metadata).toEqual({ count: 4, truncated: false })
})

test("list ignore parameter hides matching files", async () => {
  const ctx = makeCtx(root)
  const without = await ListTool.execute({ path: "tree" }, ctx)
  expect(without.output).toContain("debug.log")
  const withIgnore = await ListTool.execute({ path: "tree", ignore: ["*.log"] }, ctx)
  expect(withIgnore.output).not.toContain("debug.log")
})

test("list truncates at 100 files", async () => {
  const ctx = makeCtx(root)
  const result = await ListTool.execute({ path: "many2" }, ctx)
  const lines = result.output.split("\n")
  expect(lines[lines.length - 1]).toBe("(Listing truncated at 100 files.)")
  expect(lines.filter((l) => l.startsWith("  ")).length).toBe(100)
  expect(result.metadata).toEqual({ count: 100, truncated: true })
})

test("list rejects a missing directory", async () => {
  const ctx = makeCtx(root)
  const err = await ListTool.execute({ path: "does-not-exist" }, ctx).catch((e: unknown) => e)
  expect(err).toBeInstanceOf(ToolInputError)
})
