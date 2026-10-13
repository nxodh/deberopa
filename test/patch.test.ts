import { afterAll, beforeEach, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { PatchTool, parsePatch, applyHunks } from "../src/tool/patch"
import { markRead } from "../src/tool/filetime"
import { PermissionDeniedError, type PermissionRequest, type ToolContext } from "../src/tool/tool"
import { endProject, tmpDir, useProject } from "./helpers"

let dir: string
let asked: PermissionRequest[]
let deny = false

const ctx = (): ToolContext => ({
  sessionID: "s-patch",
  messageID: "m",
  callID: "c",
  agent: "build",
  abort: new AbortController().signal,
  directory: dir,
  worktree: dir,
  ask: async (r) => {
    asked.push(r)
    if (deny) throw new PermissionDeniedError()
  },
  metadata: () => {},
})

const write = (name: string, content: string) => {
  const file = path.join(dir, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  markRead("s-patch", file)
  return file
}
const read = (name: string) => fs.readFileSync(path.join(dir, name), "utf8")
const patch = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`
const run = (text: string) => PatchTool.execute({ patchText: text }, ctx())

beforeEach(() => {
  dir = tmpDir()
  asked = []
  deny = false
  useProject(dir, { snapshot: false, lsp: false, formatter: false })
})
afterAll(endProject)

test("parsing every kind of section", () => {
  const ops = parsePatch(
    patch(
      ["*** Add File: a.txt", "+one", "+two", "*** Delete File: b.txt", "*** Update File: c.ts", "*** Move to: d.ts", "@@ function f", " keep", "-old", "+new", "*** End of File"].join("\n"),
    ),
  )
  expect(ops.map((o) => o.kind)).toEqual(["add", "delete", "update"])
  expect(ops[0]).toMatchObject({ path: "a.txt", content: "one\ntwo\n" })
  const update = ops[2] as any
  expect(update.moveTo).toBe("d.ts")
  expect(update.hunks[0]).toMatchObject({ header: "function f", eof: true })
  expect(update.hunks[0].lines).toEqual([{ op: " ", text: "keep" }, { op: "-", text: "old" }, { op: "+", text: "new" }])
})

test("malformed patches are explained", () => {
  expect(() => parsePatch("*** Update File: x\n-a")).toThrow("Begin Patch")
  expect(() => parsePatch("*** Begin Patch\n*** Add File: x\n+a")).toThrow("closing")
  expect(() => parsePatch(patch("*** Add File: x\nnot-plus"))).toThrow('must start with "+"')
  expect(() => parsePatch(patch("*** Update File: x\n@@\n?bad"))).toThrow("hunk lines must start")
  expect(() => parsePatch(patch("junk"))).toThrow("expected")
  expect(() => parsePatch(patch(""))).toThrow("no file operations")
})

test("add, update and delete in one atomic patch", async () => {
  write("src/app.ts", "import a from 'a'\n\nexport function run() {\n  return 1\n}\n")
  write("old.txt", "obsolete\n")
  const result = await run(
    patch(
      [
        "*** Add File: docs/note.md",
        "+# Note",
        "+hello",
        "*** Update File: src/app.ts",
        "@@ export function run() {",
        "   return 1",
        " }",
        "+",
        "+export const x = 2",
        "*** Delete File: old.txt",
      ].join("\n"),
    ),
  )
  expect(read("docs/note.md")).toBe("# Note\nhello\n")
  expect(read("src/app.ts")).toBe("import a from 'a'\n\nexport function run() {\n  return 1\n}\n\nexport const x = 2\n")
  expect(fs.existsSync(path.join(dir, "old.txt"))).toBe(false)
  expect(result.output).toContain("created docs/note.md")
  expect(asked).toHaveLength(1)
  expect(asked[0]!.permission).toBe("edit")
  expect(asked[0]!.patterns.sort()).toEqual(["docs/note.md", "old.txt", "src/app.ts"])
  expect(result.metadata?.additions).toBeGreaterThan(0)
})

test("move with changes", async () => {
  write("a/old.ts", "const a = 1\nconst b = 2\n")
  await run(patch(["*** Update File: a/old.ts", "*** Move to: b/new.ts", "@@", "-const a = 1", "+const a = 10", " const b = 2"].join("\n")))
  expect(fs.existsSync(path.join(dir, "a/old.ts"))).toBe(false)
  expect(read("b/new.ts")).toBe("const a = 10\nconst b = 2\n")
})

test("whitespace and typographic drift is tolerated, line endings are kept", () => {
  const original = "function f() {\r\n\treturn “hello”  \r\n}\r\n"
  const out = applyHunks(original, [{ lines: [{ op: "-", text: '  return "hello"' }, { op: "+", text: "  return 'bye'" }], eof: false }], "f.js")
  expect(out).toBe("function f() {\r\n  return 'bye'\r\n}\r\n")
})

test("several hunks apply in order, and identical lines resolve by position", () => {
  const original = "a\nx\nb\nx\nc\n"
  const out = applyHunks(
    original,
    [
      // "x" appears twice; the context line "b" pins this edit to the second one
      { lines: [{ op: " ", text: "b" }, { op: "-", text: "x" }, { op: "+", text: "X2" }], eof: false },
      { lines: [{ op: "-", text: "c" }, { op: "+", text: "C" }], eof: false },
    ],
    "f",
  )
  expect(out).toBe("a\nx\nb\nX2\nC\n")
  // an addition-only hunk at the end of the file
  expect(applyHunks("one\ntwo\n", [{ lines: [{ op: "+", text: "three" }], eof: true }], "f")).toBe("one\ntwo\nthree\n")
})

test("hunks must be in file order, and missing context is reported", async () => {
  write("f.txt", "one\ntwo\nthree\n")
  await expect(run(patch(["*** Update File: f.txt", "@@", "-three", "+3", "@@", "-one", "+1"].join("\n")))).rejects.toThrow("Hunk 2")
  await expect(run(patch(["*** Update File: f.txt", "@@", "-nope", "+x"].join("\n")))).rejects.toThrow("not found")
  expect(read("f.txt")).toBe("one\ntwo\nthree\n")
})

test("nothing is written when any file fails", async () => {
  write("ok.txt", "keep\n")
  const promise = run(patch(["*** Add File: new.txt", "+x", "*** Update File: ok.txt", "@@", "-missing line", "+y"].join("\n")))
  await expect(promise).rejects.toThrow("not found")
  expect(fs.existsSync(path.join(dir, "new.txt"))).toBe(false)
  expect(read("ok.txt")).toBe("keep\n")
  expect(asked).toHaveLength(0) // never asked: the plan failed before anything could be applied
})

test("guards: unread files, existing targets, duplicates, permission", async () => {
  fs.writeFileSync(path.join(dir, "unread.txt"), "x\n")
  await expect(run(patch(["*** Update File: unread.txt", "@@", "-x", "+y"].join("\n")))).rejects.toThrow("read the file")
  write("exists.txt", "x\n")
  await expect(run(patch("*** Add File: exists.txt\n+y"))).rejects.toThrow("already exists")
  await expect(run(patch("*** Delete File: ghost.txt"))).rejects.toThrow("does not exist")
  await expect(run(patch("*** Add File: d.txt\n+1\n*** Add File: d.txt\n+2"))).rejects.toThrow("more than once")

  write("p.txt", "a\n")
  deny = true
  await expect(run(patch(["*** Update File: p.txt", "@@", "-a", "+b"].join("\n")))).rejects.toThrow()
  expect(read("p.txt")).toBe("a\n")
})

test("a file read through the tool stays editable after a patch", async () => {
  write("chain.txt", "1\n")
  await run(patch(["*** Update File: chain.txt", "@@", "-1", "+2"].join("\n")))
  await run(patch(["*** Update File: chain.txt", "@@", "-2", "+3"].join("\n")))
  expect(read("chain.txt")).toBe("3\n")
})
