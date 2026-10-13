import fs from "node:fs/promises"
import path from "node:path"
import { Paths } from "../global"
import { project } from "../project"
import { getConfig } from "../config/config"
import { run, which } from "../util/shell"
import { createLogger } from "../util/log"

const log = createLogger("snapshot")

/**
 * Undo support. Before each step we record the working tree as a git tree object in a
 * private repository (never the user's own .git), so changes can be listed and rolled back
 * without touching their history, index or stashes.
 */
let ready: Promise<string | undefined> | undefined

async function gitDir(): Promise<string | undefined> {
  return (ready ??= (async () => {
    const config = await getConfig()
    const p = project()
    if (config.snapshot === false || p.vcs !== "git" || !which("git")) return undefined
    const dir = path.join(Paths.snapshot, p.id)
    try {
      await fs.mkdir(dir, { recursive: true })
      const exists = await fs.stat(path.join(dir, "HEAD")).then(() => true, () => false)
      if (!exists) {
        const init = await git(dir, ["init", "--quiet"])
        if (init.code !== 0) throw new Error(init.stderr)
        // Store bytes exactly as they are on disk, on every platform.
        await git(dir, ["config", "core.autocrlf", "false"])
        await git(dir, ["config", "core.longpaths", "true"])
      }
      return dir
    } catch (err) {
      log.warn("snapshots unavailable", err)
      return undefined
    }
  })())
}

function git(dir: string, args: string[], timeout = 60_000) {
  const worktree = project().worktree
  return run("git", ["--git-dir", dir, "--work-tree", worktree, ...args], {
    cwd: worktree,
    timeout,
    env: { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  })
}

/** Record the current working tree; returns a tree hash to diff or restore against. */
export async function track(): Promise<string | undefined> {
  const dir = await gitDir()
  if (!dir) return undefined
  const add = await git(dir, ["add", "--all", "."])
  if (add.code !== 0) {
    log.warn("git add failed", add.stderr)
    return undefined
  }
  const tree = await git(dir, ["write-tree"])
  const hash = tree.stdout.trim()
  return tree.code === 0 && /^[0-9a-f]{40,64}$/.test(hash) ? hash : undefined
}

/** Files (absolute paths) that differ between snapshot `hash` and the working tree now. */
export async function changedFiles(hash: string): Promise<string[]> {
  const dir = await gitDir()
  if (!dir) return []
  await git(dir, ["add", "--all", "."])
  const diff = await git(dir, ["diff", "--name-only", "-z", hash, "--", "."])
  if (diff.code !== 0) return []
  return diff.stdout
    .split("\0")
    .filter(Boolean)
    .map((rel) => path.join(project().worktree, rel))
}

/** Put the given files back to how they were in snapshot `hash` (deleting ones that did not exist then). */
export async function revertFiles(hash: string, files: string[]) {
  const dir = await gitDir()
  if (!dir) return
  const worktree = project().worktree
  for (const file of files) {
    const rel = path.relative(worktree, file).split(path.sep).join("/")
    const result = await git(dir, ["checkout", hash, "--", rel])
    if (result.code === 0) continue
    const known = await git(dir, ["ls-tree", hash, "--", rel])
    // Not part of the snapshot: the file was created afterwards, so undoing means removing it.
    if (known.code === 0 && known.stdout.trim() === "") await fs.rm(file, { force: true })
    else log.warn("could not revert file", { file, error: result.stderr })
  }
}

/** Restore the whole tracked tree to snapshot `hash`. */
export async function restore(hash: string) {
  const dir = await gitDir()
  if (!dir) return
  const now = await changedFiles(hash)
  await revertFiles(hash, now)
}

/** Unified diff between a snapshot and the working tree. */
export async function diffSince(hash: string): Promise<string> {
  const dir = await gitDir()
  if (!dir) return ""
  await git(dir, ["add", "--all", "."])
  const diff = await git(dir, ["diff", "--no-ext-diff", hash, "--", "."])
  return diff.code === 0 ? diff.stdout : ""
}

export function resetSnapshot() {
  ready = undefined
}
