import { run } from "../util/shell"

export interface GitStatus {
  /** Branch name, or the short commit hash when HEAD is detached. */
  branch: string
  detached: boolean
  ahead: number
  behind: number
  /** Files with any change relative to HEAD (staged, unstaged, untracked or conflicted). */
  changed: number
  staged: number
  untracked: number
  conflicts: number
}

/** Parse `git status --porcelain=v1 -b` output. Returns undefined when it is not recognisable. */
export function parseStatus(output: string): GitStatus | undefined {
  const lines = output.split(/\r?\n/).filter((l) => l !== "")
  const head = lines[0]
  if (!head?.startsWith("## ")) return undefined
  const info = head.slice(3)
  let branch: string
  let detached = false
  let ahead = 0
  let behind = 0

  if (info.startsWith("No commits yet on ")) branch = info.slice("No commits yet on ".length)
  else if (info.startsWith("Initial commit on ")) branch = info.slice("Initial commit on ".length)
  else if (info.startsWith("HEAD (no branch)")) {
    branch = "HEAD"
    detached = true
  } else {
    const track = /\s\[([^\]]*)\]$/.exec(info)
    const names = track ? info.slice(0, track.index) : info
    branch = names.split("...")[0]!
    if (track) {
      ahead = Number(/ahead (\d+)/.exec(track[1]!)?.[1] ?? 0)
      behind = Number(/behind (\d+)/.exec(track[1]!)?.[1] ?? 0)
    }
  }

  let staged = 0
  let untracked = 0
  let conflicts = 0
  for (const line of lines.slice(1)) {
    const x = line[0]!
    const y = line[1]!
    if (x === "?" && y === "?") untracked++
    else if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) conflicts++
    else if (x !== " " && x !== "!") staged++
  }
  return { branch, detached, ahead, behind, changed: lines.length - 1, staged, untracked, conflicts }
}

/**
 * Branch and working-tree summary for `cwd`, or undefined outside a repository, without git, or
 * when git is slow. Read-only: optional locks are off so it never blocks the user's own git.
 */
export async function gitStatus(cwd: string, timeoutMs = 4000): Promise<GitStatus | undefined> {
  const result = await run("git", ["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-b", "--untracked-files=normal"], {
    cwd,
    timeout: timeoutMs,
    env: { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
  })
  if (result.code !== 0) return undefined
  const status = parseStatus(result.stdout)
  if (status?.detached) {
    const hash = await run("git", ["rev-parse", "--short", "HEAD"], { cwd, timeout: timeoutMs, env: { GIT_OPTIONAL_LOCKS: "0" } })
    if (hash.code === 0 && hash.stdout.trim()) status.branch = hash.stdout.trim()
  }
  return status
}

/** True when `file` is covered by the repository's ignore rules (and so is not tracked or snapshotted). */
export async function isIgnored(cwd: string, file: string): Promise<boolean> {
  const result = await run("git", ["check-ignore", "-q", "--", file], { cwd, timeout: 4000, env: { GIT_OPTIONAL_LOCKS: "0" } })
  return result.code === 0
}

/** One short line for the status bar: `main · 3 changed · ↑1 ↓2`. */
export function formatStatus(status: GitStatus): string {
  const parts = [status.detached ? `(${status.branch})` : status.branch]
  if (status.conflicts) parts.push(`${status.conflicts} conflict${status.conflicts === 1 ? "" : "s"}`)
  if (status.changed) parts.push(`${status.changed} changed`)
  const sync = [status.ahead ? `↑${status.ahead}` : "", status.behind ? `↓${status.behind}` : ""].filter(Boolean).join(" ")
  if (sync) parts.push(sync)
  return parts.join(" · ")
}
