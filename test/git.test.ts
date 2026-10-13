import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { formatStatus, gitStatus, isIgnored, parseStatus } from "../src/git/git"
import { snapshotStatus } from "../src/snapshot/snapshot"
import { endProject, tmpDir, useProject } from "./helpers"

afterAll(endProject)

test("parses porcelain output: branch, tracking, counts", () => {
  const s = parseStatus("## feature/x...origin/feature/x [ahead 2, behind 1]\n M src/a.ts\nA  src/new.ts\n?? notes.txt\nUU conflict.ts\nMM both.ts\n")!
  expect(s).toMatchObject({ branch: "feature/x", detached: false, ahead: 2, behind: 1, changed: 5, staged: 2, untracked: 1, conflicts: 1 })
  expect(parseStatus("## main\n")).toMatchObject({ branch: "main", changed: 0, ahead: 0, behind: 0 })
  expect(parseStatus("## main...origin/main\n")).toMatchObject({ branch: "main", ahead: 0 })
  expect(parseStatus("## main...origin/main [gone]\n")).toMatchObject({ branch: "main", ahead: 0, behind: 0 })
  expect(parseStatus("## No commits yet on trunk\n?? a\n")).toMatchObject({ branch: "trunk", untracked: 1 })
  expect(parseStatus("## HEAD (no branch)\n")).toMatchObject({ detached: true })
  expect(parseStatus("fatal: not a git repository")).toBeUndefined()
})

test("status line for the bar", () => {
  expect(formatStatus({ branch: "main", detached: false, ahead: 0, behind: 0, changed: 0, staged: 0, untracked: 0, conflicts: 0 })).toBe("main")
  expect(formatStatus({ branch: "main", detached: false, ahead: 1, behind: 2, changed: 3, staged: 0, untracked: 1, conflicts: 0 })).toBe("main · 3 changed · ↑1 ↓2")
  expect(formatStatus({ branch: "a1b2c3d", detached: true, ahead: 0, behind: 0, changed: 1, staged: 0, untracked: 0, conflicts: 1 })).toBe("(a1b2c3d) · 1 conflict · 1 changed")
})

let repo: string
beforeAll(() => {
  repo = tmpDir()
  const g = (...a: string[]) => spawnSync("git", a, { cwd: repo, encoding: "utf8" })
  g("init", "-q", "-b", "trunk")
  g("config", "user.email", "t@example.com")
  g("config", "user.name", "t")
  fs.writeFileSync(path.join(repo, ".gitignore"), "ignored.txt\n")
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n")
  g("add", "-A")
  g("commit", "-qm", "init")
})

test("real repository: clean, then dirty", async () => {
  expect(await gitStatus(repo)).toMatchObject({ branch: "trunk", changed: 0 })
  fs.writeFileSync(path.join(repo, "a.txt"), "changed\n")
  fs.writeFileSync(path.join(repo, "new.txt"), "n\n")
  expect(await gitStatus(repo)).toMatchObject({ branch: "trunk", changed: 2, untracked: 1 })
})

test("outside a repository there is no status", async () => {
  expect(await gitStatus(tmpDir())).toBeUndefined()
})

test("ignored files are recognised", async () => {
  fs.writeFileSync(path.join(repo, "ignored.txt"), "x")
  expect(await isIgnored(repo, "ignored.txt")).toBe(true)
  expect(await isIgnored(repo, "a.txt")).toBe(false)
})

test("snapshot status explains why undo cannot restore files", async () => {
  useProject(repo, { snapshot: false })
  expect(await snapshotStatus()).toMatchObject({ available: false, reason: expect.stringContaining("turned off") })
  useProject(tmpDir(), {})
  expect(await snapshotStatus()).toMatchObject({ available: false, reason: expect.stringContaining("not a git repository") })
  useProject(repo, {})
  expect(await snapshotStatus()).toEqual({ available: true })
})
