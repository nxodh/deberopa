/** Subsequence match with a score that rewards consecutive hits and hits at word starts. Higher is better. */
export function fuzzyScore(query: string, target: string): number | undefined {
  if (query === "") return 0
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  let score = 0
  let ti = 0
  let streak = 0
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi]!
    const found = t.indexOf(ch, ti)
    if (found === -1) return undefined
    streak = found === ti ? streak + 1 : 0
    const previous = found === 0 ? "/" : t[found - 1]!
    const boundary = previous === "/" || previous === "\\" || previous === "-" || previous === "_" || previous === "." || previous === " "
    score += 1 + streak * 3 + (boundary ? 6 : 0) - Math.min(found - ti, 8) * 0.2
    ti = found + 1
  }
  // prefer shorter targets and matches in the file name over the directory part
  const base = t.lastIndexOf("/") + 1
  if (t.slice(base).includes(q)) score += 12
  return score - target.length * 0.02
}

export function fuzzyFilter<T>(query: string, items: T[], text: (item: T) => string, limit = 50): T[] {
  if (query === "") return items.slice(0, limit)
  const scored: { item: T; score: number }[] = []
  for (const item of items) {
    const score = fuzzyScore(query, text(item))
    if (score !== undefined) scored.push({ item, score })
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.item)
}
