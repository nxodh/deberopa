/**
 * Markdown frontmatter with a small YAML subset: scalars, nested maps by indentation,
 * `- item` lists, inline `[a, b]` lists and `|` block strings. Enough for agent, command
 * and skill definitions without pulling in a YAML dependency.
 */
export interface Frontmatter {
  data: Record<string, any>
  content: string
}

export function parseFrontmatter(source: string): Frontmatter {
  const text = source.replace(/^﻿/, "").replace(/\r\n/g, "\n")
  const match = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text)
  if (!match) return { data: {}, content: text.trim() }
  let data: Record<string, any> = {}
  try {
    data = parseYaml(match[1] ?? "")
  } catch {
    data = {}
  }
  return { data, content: text.slice(match[0].length).trim() }
}

function scalar(raw: string): any {
  const v = raw.trim()
  if (v === "") return ""
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    if (v.startsWith('"')) {
      try {
        return JSON.parse(v)
      } catch {}
    }
    return v.slice(1, -1)
  }
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim()
    return inner === "" ? [] : splitInline(inner).map(scalar)
  }
  if (v === "true") return true
  if (v === "false") return false
  if (v === "null" || v === "~") return null
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v)
  return v.replace(/\s+#.*$/, "")
}

function splitInline(inner: string): string[] {
  const out: string[] = []
  let current = ""
  let quote = ""
  for (const ch of inner) {
    if (quote) {
      current += ch
      if (ch === quote) quote = ""
    } else if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
    } else if (ch === ",") {
      out.push(current)
      current = ""
    } else current += ch
  }
  if (current.trim() !== "") out.push(current)
  return out
}

interface Row {
  indent: number
  text: string
}

export function parseYaml(source: string): Record<string, any> {
  const rows: Row[] = source
    .split("\n")
    .filter((l) => l.trim() !== "" && !l.trim().startsWith("#"))
    .map((l) => ({ indent: l.length - l.trimStart().length, text: l.trim() }))
  let i = 0

  function block(indent: number): any {
    const first = rows[i]
    if (!first) return {}
    if (first.text.startsWith("- ") || first.text === "-") {
      const list: any[] = []
      while (i < rows.length && rows[i]!.indent === indent && (rows[i]!.text.startsWith("- ") || rows[i]!.text === "-")) {
        const item = rows[i]!.text.slice(1).trim()
        i++
        if (item === "") list.push(i < rows.length && rows[i]!.indent > indent ? block(rows[i]!.indent) : null)
        else list.push(scalar(item))
      }
      return list
    }
    const map: Record<string, any> = {}
    while (i < rows.length && rows[i]!.indent === indent) {
      const row = rows[i]!
      const colon = row.text.indexOf(":")
      if (colon === -1) {
        i++
        continue
      }
      const key = row.text.slice(0, colon).trim().replace(/^["']|["']$/g, "")
      const rest = row.text.slice(colon + 1).trim()
      i++
      if (rest === "|" || rest === ">" || rest === "|-" || rest === ">-") {
        const lines: string[] = []
        while (i < rows.length && rows[i]!.indent > indent) lines.push(rows[i++]!.text)
        map[key] = lines.join(rest.startsWith(">") ? " " : "\n")
      } else if (rest === "") {
        map[key] = i < rows.length && rows[i]!.indent > indent ? block(rows[i]!.indent) : ""
      } else map[key] = scalar(rest)
    }
    return map
  }

  const result = rows.length ? block(rows[0]!.indent) : {}
  return typeof result === "object" && !Array.isArray(result) ? result : {}
}
