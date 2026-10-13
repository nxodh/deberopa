/** Pure helpers for building `@file#L10-20` references. Kept free of the `vscode` module so they are testable. */

export interface Selection {
  /** 0-based line numbers as VS Code reports them. */
  startLine: number
  endLine: number
  /** The selection ends at column 0 of `endLine`, so that line is not really included. */
  endAtLineStart: boolean
  isEmpty: boolean
}

/** Paths with characters the prompt's @-parser would stop at are not referenced by name. */
const SAFE_PATH = /^[^\s@`,;:!?()[\]{}<>"']+$/

export function toPosix(p: string): string {
  return p.replace(/\\/g, "/")
}

/**
 * `@src/a.ts`, `@src/a.ts#L10`, or `@src/a.ts#L10-20` followed by a space, ready to type into
 * the prompt. Returns undefined when the path cannot be written as a mention.
 */
export function formatReference(relativePath: string, selection?: Selection): string | undefined {
  const file = toPosix(relativePath)
  if (!SAFE_PATH.test(file)) return undefined
  if (!selection || selection.isEmpty) return `@${file} `
  const start = selection.startLine + 1
  // a selection that ends at the very start of a line (shift+down) does not include that line
  let end = selection.endLine + 1
  if (selection.endAtLineStart && end > start) end -= 1
  return end > start ? `@${file}#L${start}-${end} ` : `@${file}#L${start} `
}

/** Workspace-relative path when the file is inside a workspace folder, otherwise the absolute path. */
export function relativeTo(root: string | undefined, file: string): string {
  if (!root) return file
  const r = toPosix(root).replace(/\/+$/, "")
  const f = toPosix(file)
  const insensitive = /^[a-zA-Z]:/.test(r)
  const same = (a: string, b: string) => (insensitive ? a.toLowerCase() === b.toLowerCase() : a === b)
  if (f.length > r.length && same(f.slice(0, r.length), r) && f[r.length] === "/") return f.slice(r.length + 1)
  return file
}
