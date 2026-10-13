/** Glob-ish matching used by permission rules: `*` matches anything, `?` one character. */
export function wildcardMatch(input: string, pattern: string): boolean {
  let source = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
  // "git status *" should also match a bare "git status"
  if (source.endsWith(" .*")) source = source.slice(0, -3) + "( .*)?"
  return new RegExp(`^${source}$`, "s").test(input)
}

/** Later rules win, mirroring how config objects are written top to bottom. */
export function wildcardLookup<T>(input: string, rules: Record<string, T>): T | undefined {
  let result: T | undefined
  for (const [pattern, value] of Object.entries(rules)) {
    if (wildcardMatch(input, pattern)) result = value
  }
  return result
}
