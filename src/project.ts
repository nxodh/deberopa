import path from "node:path"
import fs from "node:fs"
import { createHash } from "node:crypto"

export interface Project {
  /** Stable id derived from the worktree path. */
  id: string
  /** Directory the session works in (where the user launched us). */
  directory: string
  /** Git root when inside a repository, otherwise `directory`. */
  worktree: string
  vcs?: "git"
}

let current: Project | undefined

function findGitRoot(start: string): string | undefined {
  let dir = start
  while (true) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

export function initProject(directory = process.cwd()): Project {
  const dir = path.resolve(directory)
  const git = findGitRoot(dir)
  const worktree = git ?? dir
  // Windows paths are case-insensitive; normalise so the same folder always maps to one project.
  const key = process.platform === "win32" ? worktree.toLowerCase() : worktree
  current = {
    id: createHash("sha1").update(key).digest("hex").slice(0, 16),
    directory: dir,
    worktree,
    vcs: git ? "git" : undefined,
  }
  return current
}

export function project(): Project {
  return current ?? initProject()
}
