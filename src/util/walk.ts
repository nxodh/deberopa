import type { Dirent } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import ignore from "ignore"

export interface WalkOptions {
  cwd: string
  /** Include dotfiles. Default true. */
  hidden?: boolean
  /** Honor .gitignore / .ignore / .git/info/exclude and the built-in skip list. Default true. */
  respectIgnore?: boolean
  signal?: AbortSignal
  /** Stop after yielding this many files. */
  limit?: number
  /** Extra gitignore-style patterns, applied relative to `cwd` regardless of `respectIgnore`. */
  extraIgnore?: string[]
}

/** Directories skipped by name when respectIgnore is on. Files with these names are still yielded. */
const SKIP_DIRS = new Set([".git", "node_modules", ".hg", ".svn", "__pycache__", ".venv"])

const IGNORE_FILES = [".gitignore", ".ignore"]

type Matcher = ReturnType<typeof ignore>

interface Scope {
  /** Posix path of the directory holding the ignore file, relative to cwd. "" for the root. */
  base: string
  matcher: Matcher
}

export interface WalkEntry {
  path: string
  rel: string
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8")
  } catch {
    return undefined
  }
}

/** A path is ignored if the deepest scope with a matching rule says so. */
function isIgnored(scopes: Scope[], rel: string, isDir: boolean): boolean {
  const target = isDir ? `${rel}/` : rel
  for (let i = scopes.length - 1; i >= 0; i--) {
    const scope = scopes[i]!
    const sub = scope.base ? target.slice(scope.base.length + 1) : target
    const result = scope.matcher.test(sub)
    if (result.ignored) return true
    if (result.unignored) return false
  }
  return false
}

/** Yields files under `cwd`, depth-first, entries sorted by name within each directory. */
export async function* walk(opts: WalkOptions): AsyncGenerator<WalkEntry> {
  const root = path.resolve(opts.cwd)
  const respectIgnore = opts.respectIgnore ?? true
  const hidden = opts.hidden ?? true
  const signal = opts.signal
  const limit = opts.limit
  let yielded = 0

  const rootScopes: Scope[] = []
  if (respectIgnore) {
    const exclude = await readText(path.join(root, ".git", "info", "exclude"))
    if (exclude !== undefined) rootScopes.push({ base: "", matcher: ignore().add(exclude) })
  }
  if (opts.extraIgnore?.length) rootScopes.push({ base: "", matcher: ignore().add(opts.extraIgnore) })

  async function* visit(dirAbs: string, dirRel: string, inherited: Scope[]): AsyncGenerator<WalkEntry> {
    if (signal?.aborted) return
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true })
    } catch {
      // Unreadable directories are skipped rather than failing the whole walk.
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

    let scopes = inherited
    if (respectIgnore) {
      const present = new Set(entries.map((e) => e.name))
      const matcher = ignore()
      let found = false
      // .ignore is added after .gitignore so its rules take precedence within the same directory.
      for (const name of IGNORE_FILES) {
        if (!present.has(name)) continue
        const text = await readText(path.join(dirAbs, name))
        if (text === undefined) continue
        matcher.add(text)
        found = true
      }
      if (found) scopes = [...inherited, { base: dirRel, matcher }]
    }

    for (const entry of entries) {
      if (signal?.aborted) return
      if (limit !== undefined && yielded >= limit) return
      const name = entry.name
      if (!hidden && name.startsWith(".")) continue
      const rel = dirRel ? `${dirRel}/${name}` : name
      const abs = path.join(dirAbs, name)

      if (entry.isDirectory()) {
        if (respectIgnore && SKIP_DIRS.has(name)) continue
        if (isIgnored(scopes, rel, true)) continue
        yield* visit(abs, rel, scopes)
        continue
      }

      let isFile = entry.isFile()
      // Symlinks: a link to a file counts as a file; links to directories are never followed.
      if (entry.isSymbolicLink()) isFile = await fs.stat(abs).then((s) => s.isFile(), () => false)
      if (!isFile) continue
      if (isIgnored(scopes, rel, false)) continue

      yielded++
      yield { path: abs, rel }
    }
  }

  yield* visit(root, "", rootScopes)
}

/** Relative posix paths of every file `walk` yields. */
export async function listFiles(opts: WalkOptions): Promise<string[]> {
  const out: string[] = []
  for await (const file of walk(opts)) out.push(file.rel)
  return out
}
