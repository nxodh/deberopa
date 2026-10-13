import stringWidth from "string-width"

export interface Span {
  text: string
  bold?: boolean
  italic?: boolean
  dim?: boolean
  underline?: boolean
  inverse?: boolean
  strikethrough?: boolean
  code?: boolean
}

export type Line = Span[]

type FlagKey = "bold" | "italic" | "dim" | "underline" | "inverse" | "strikethrough" | "code"
type Flags = Partial<Record<FlagKey, boolean>>
interface Block {
  lines: Line[]
  next: number
}

const FLAG_KEYS: readonly FlagKey[] = ["bold", "italic", "dim", "underline", "inverse", "strikethrough", "code"]
const MIN_COLS = 10
const MAX_COLS = 10_000
// A quote or list item needs at least this many columns for its content; narrower input stays paragraph text.
const MIN_INNER = 4
// Container nesting limit so pathological input cannot recurse without bound.
const MAX_DEPTH = 32
const GUTTER_TEXT = "│ "
const BAR_TEXT = "▎ "
const PUNCT = /[\p{P}\p{S}]/u
const SPACE = /\s/
const ASCII_PUNCT = /[!-\/:-@\[-`{-~]/
// Bounded quantifiers keep autolink scanning linear.
const AUTOLINK = /<((?:https?|ftp):\/\/[^\s<>]{1,2048}|mailto:[^\s<>]{1,512})>/y
const QUOTE_RE = /^ {0,3}>/
const DELIM_CELL = /^:?-+:?$/
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
const widthCache = new Map<string, number>()

/** Render markdown into lines no wider than `width` terminal cells. */
export function renderMarkdown(source: string, width: number): Line[] {
  const cols = Math.max(MIN_COLS, clampCols(width))
  const text = sanitize(typeof source === "string" ? source : "")
  const lines = renderBlocks(text.split("\n"), cols, 0, false).map((l) => mergeSpans(l))
  return normalizeBlanks(lines)
}

/** Wrap pre-styled spans to `width` cells (word-wrap; hard-break words longer than the width; CJK may break between any two wide chars). */
export function wrapSpans(spans: Span[], width: number, opts: { indent?: Span[]; firstIndent?: Span[] } = {}): Line[] {
  const max = clampCols(width)
  const rest = fitPrefix(opts.indent ?? [], max)
  const first = fitPrefix(opts.firstIndent ?? opts.indent ?? [], max)
  const { cells, styles } = toCells(spans)
  return wrapCells(cells, styles, max, first, rest, false)
}

/** Visible width of a line in terminal cells. */
export function lineWidth(line: Line): number {
  let text = ""
  for (const s of line) text += s.text
  return stringWidth(text)
}

/** Plain-text projection of rendered lines (for tests / copying). */
export function linesToText(lines: Line[]): string {
  return lines.map((l) => l.map((s) => s.text).join("")).join("\n")
}

// ---------------------------------------------------------------------------
// Input normalisation and width helpers

function clampCols(width: number): number {
  if (Number.isNaN(width)) return 80
  return Math.min(MAX_COLS, Math.max(2, Math.floor(width)))
}

function sanitize(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/[\u2028\u2029]/g, " ")
    // Strips ESC and other control bytes so no terminal sequence can leak through.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
}

function normalizeBlanks(lines: Line[]): Line[] {
  const out: Line[] = []
  for (const l of lines) {
    if (l.length === 0 && (out.length === 0 || out[out.length - 1]?.length === 0)) continue
    out.push(l)
  }
  while (out.length > 0 && out[out.length - 1]?.length === 0) out.pop()
  return out
}

function cellWidth(g: string): number {
  let w = widthCache.get(g)
  if (w === undefined) {
    w = stringWidth(g)
    if (widthCache.size >= 4096) widthCache.clear()
    widthCache.set(g, w)
  }
  return w
}

function normFlags(s: Partial<Span>): Flags {
  const f: Flags = {}
  for (const k of FLAG_KEYS) if (s[k]) f[k] = true
  return f
}

function sameFlags(a: Partial<Span>, b: Partial<Span>): boolean {
  return FLAG_KEYS.every((k) => !!a[k] === !!b[k])
}

/** Drops empty spans and merges neighbours with identical flags. */
function mergeSpans(spans: Span[]): Span[] {
  const out: Span[] = []
  for (const s of spans) {
    const text = typeof s.text === "string" ? s.text : ""
    if (text === "") continue
    const last = out[out.length - 1]
    if (last && sameFlags(last, s)) last.text += text
    else out.push({ ...normFlags(s), text })
  }
  return out
}

// ---------------------------------------------------------------------------
// Wrapping

interface Cell {
  g: string
  w: number
  s: number
  space: boolean
}

function toCells(spans: Span[]): { cells: Cell[]; styles: Flags[] } {
  const styles: Flags[] = []
  const ends: number[] = []
  let full = ""
  for (const s of spans) {
    styles.push(normFlags(s))
    full += typeof s.text === "string" ? s.text : ""
    ends.push(full.length)
  }
  const cells: Cell[] = []
  let si = 0
  for (const { segment, index } of segmenter.segment(full)) {
    // A grapheme takes the style of the span where it starts.
    while (si < ends.length - 1 && index >= (ends[si] ?? 0)) si++
    if (segment.includes("\n")) {
      cells.push({ g: "\n", w: 0, s: si, space: false })
    } else if (segment === "\t") {
      cells.push({ g: " ", w: 1, s: si, space: true }, { g: " ", w: 1, s: si, space: true })
    } else {
      cells.push({ g: segment, w: cellWidth(segment), s: si, space: SPACE.test(segment) })
    }
  }
  return { cells, styles }
}

function buildLine(prefix: Span[], cells: Cell[], styles: Flags[]): Line {
  const spans: Span[] = prefix.slice()
  let cur = -1
  let buf = ""
  for (const c of cells) {
    if (c.s !== cur) {
      if (buf !== "") spans.push({ ...styles[cur], text: buf })
      cur = c.s
      buf = ""
    }
    buf += c.g
  }
  if (buf !== "") spans.push({ ...styles[cur], text: buf })
  return mergeSpans(spans)
}

/** Truncates a prefix (list marker, quote bar) so that it always leaves at least two columns for content. */
function fitPrefix(prefix: Span[], max: number): Span[] {
  if (lineWidth(prefix) <= max - 2) return prefix
  const { cells, styles } = toCells(prefix)
  const kept: Cell[] = []
  let w = 0
  for (const c of cells) {
    if (w + c.w > max - 2) break
    kept.push(c)
    w += c.w
  }
  return buildLine([], kept, styles)
}

/**
 * Core line filler. In word mode, breaks happen at whitespace when possible and words
 * longer than a line are broken per grapheme. In hard mode every grapheme is a break point
 * and whitespace is kept (used for code).
 */
function wrapCells(cells: Cell[], styles: Flags[], max: number, first: Span[], rest: Span[], hard: boolean): Line[] {
  const firstW = lineWidth(first)
  const restW = lineWidth(rest)
  const out: Line[] = []
  let cur: Cell[] = []
  let curW = 0

  const avail = (): number => max - (out.length === 0 ? firstW : restW)
  const emit = (): void => {
    out.push(buildLine(out.length === 0 ? first : rest, cur, styles))
    cur = []
    curW = 0
  }
  const trim = (): void => {
    let last = cur[cur.length - 1]
    while (last && last.space) {
      cur.pop()
      curW -= last.w
      last = cur[cur.length - 1]
    }
  }

  let i = 0
  while (i < cells.length) {
    const c = cells[i]
    if (!c) break
    if (c.g === "\n") {
      if (!hard) trim()
      emit()
      i++
      continue
    }
    if (hard) {
      if (curW + c.w > avail() && cur.length > 0) emit()
      cur.push(c)
      curW += c.w
      i++
      continue
    }
    if (c.space) {
      i++
      // Spaces at the start of a wrapped line are dropped.
      if (cur.length === 0 && out.length > 0) continue
      if (curW + c.w <= avail()) {
        cur.push(c)
        curW += c.w
      } else {
        trim()
        if (cur.length > 0) emit()
      }
      continue
    }
    let j = i
    let ww = 0
    while (j < cells.length) {
      const d = cells[j]
      if (!d || d.space || d.g === "\n") break
      ww += d.w
      j++
    }
    // Move the word to a fresh line only if it fits there; otherwise fill the current line and break it.
    if (curW + ww > avail() && ww <= max - restW) {
      trim()
      if (cur.length > 0) emit()
    }
    for (let k = i; k < j; k++) {
      const d = cells[k]
      if (!d) break
      if (curW + d.w > avail() && cur.length > 0) emit()
      cur.push(d)
      curW += d.w
    }
    i = j
  }
  if (!hard) trim()
  if (cur.length > 0 || (hard && out.length === 0)) emit()
  return out
}

function hardWrap(spans: Span[], width: number, prefix: Span[]): Line[] {
  const max = clampCols(width)
  const p = fitPrefix(prefix, max)
  const { cells, styles } = toCells(spans)
  return wrapCells(cells, styles, max, p, p, true)
}

// ---------------------------------------------------------------------------
// Block level

function renderBlocks(lines: string[], width: number, depth: number, tight: boolean): Line[] {
  const out: Line[] = []
  let blankBefore = false
  let i = 0
  while (i < lines.length) {
    if (isBlank(lines[i] ?? "")) {
      blankBefore = true
      i++
      continue
    }
    const block = renderBlock(lines, i, width, depth)
    if (block.lines.length > 0) {
      // Tight containers (list items) only separate blocks that were separated in the source.
      if (out.length > 0 && (!tight || blankBefore)) out.push([])
      for (const l of block.lines) out.push(l)
      blankBefore = false
    }
    i = Math.max(block.next, i + 1)
  }
  return out
}

function renderBlock(lines: string[], i: number, width: number, depth: number): Block {
  const line = lines[i] ?? ""
  const fence = matchFence(line)
  if (fence) return renderFence(lines, i, width, fence)
  if (isHr(line)) return { lines: [[{ text: "─".repeat(width), dim: true }]], next: i + 1 }
  const heading = matchHeading(line)
  if (heading) return renderHeading(heading.level, heading.text, width, i)
  if (depth < MAX_DEPTH) {
    if (QUOTE_RE.test(line) && width - 2 >= MIN_INNER) return renderQuote(lines, i, width, depth)
    const item = matchItem(line)
    if (item && width - item.prefixW >= MIN_INNER) return renderList(lines, i, width, depth, item)
  }
  if (isTableStart(lines, i)) return renderTable(lines, i, width)
  return renderParagraph(lines, i, width)
}

function isBlank(line: string): boolean {
  return line.trim() === ""
}

function leadWidth(line: string): number {
  let k = 0
  while (line[k] === " ") k++
  return k
}

function stripIndent(line: string, n: number): string {
  let k = 0
  while (k < n && line[k] === " ") k++
  return line.slice(k)
}

function isHr(line: string): boolean {
  if (leadWidth(line) > 3) return false
  return /^([-*_])\1{2,}$/.test(line.replace(/ /g, ""))
}

interface Heading {
  level: number
  text: string
}

function matchHeading(line: string): Heading | null {
  const m = /^ {0,3}(#{1,6})(?: +(.*))?$/.exec(line)
  if (!m) return null
  return { level: (m[1] ?? "").length, text: stripClosingHashes(m[2] ?? "") }
}

/** Removes an optional closing sequence ("## Title ##") without a regex, which could backtrack on long runs. */
function stripClosingHashes(s: string): string {
  const t = s.trimEnd()
  let k = t.length
  while (k > 0 && t[k - 1] === "#") k--
  if (k === t.length) return t
  if (k === 0 || t[k - 1] === " " || t[k - 1] === "\t") return t.slice(0, k).trimEnd()
  return t
}

function renderHeading(level: number, text: string, width: number, i: number): Block {
  const spans = parseInline(text).map((s): Span => (level === 1 ? { ...s, bold: true, underline: true } : { ...s, bold: true }))
  return { lines: wrapSpans(spans, width), next: i + 1 }
}

interface Fence {
  ch: string
  len: number
  indent: number
  info: string
}

function matchFence(line: string): Fence | null {
  const m = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line)
  if (!m) return null
  const run = m[2] ?? ""
  const info = (m[3] ?? "").trim()
  const ch = run[0] ?? "`"
  // A backtick fence's info string cannot contain backticks; such a line is inline code.
  if (ch === "`" && info.includes("`")) return null
  return { ch, len: run.length, indent: (m[1] ?? "").length, info }
}

function isClosingFence(line: string, f: Fence): boolean {
  const m = /^ {0,3}(`{3,}|~{3,})[ ]*$/.exec(line)
  const run = m?.[1] ?? ""
  return run !== "" && run[0] === f.ch && run.length >= f.len
}

/** An unterminated fence (common while streaming) runs to the end of the input. */
function renderFence(lines: string[], i: number, width: number, f: Fence): Block {
  let j = i + 1
  while (j < lines.length && !isClosingFence(lines[j] ?? "", f)) j++
  const out: Line[] = []
  if (f.info !== "") for (const l of wrapSpans([{ text: f.info, dim: true }], width)) out.push(l)
  for (let k = i + 1; k < j; k++) {
    const code = stripIndent(lines[k] ?? "", f.indent)
    for (const l of hardWrap([{ text: code, code: true }], width, [{ text: GUTTER_TEXT, dim: true }])) out.push(l)
  }
  return { lines: out, next: Math.min(j + 1, lines.length) }
}

function renderQuote(lines: string[], i: number, width: number, depth: number): Block {
  const inner: string[] = []
  let j = i
  while (j < lines.length && QUOTE_RE.test(lines[j] ?? "")) {
    inner.push((lines[j] ?? "").replace(/^ {0,3}> ?/, ""))
    j++
  }
  const body = renderBlocks(inner, width - 2, depth + 1, false)
  return { lines: body.map((l): Line => [{ text: BAR_TEXT, dim: true }, ...l]), next: j }
}

interface Item {
  ind: number
  ordered: boolean
  marker: string
  prefixW: number
  contentCol: number
  content: string
}

function matchItem(line: string): Item | null {
  const m = /^( *)([-*+]|\d{1,9}[.)])( *)(.*)$/.exec(line)
  if (!m) return null
  const lead = m[1] ?? ""
  const raw = m[2] ?? ""
  const gap = m[3] ?? ""
  const rest = m[4] ?? ""
  // "-foo" and "1.5" are text, not list markers.
  if (gap === "" && rest !== "") return null
  const ordered = /^\d/.test(raw)
  let marker = ordered ? `${raw.slice(0, -1)}.` : "•"
  let content = rest
  const task = /^\[([ xX])\](?: +|$)(.*)$/.exec(rest)
  if (task) {
    marker = task[1] === " " ? "☐" : "☑"
    content = task[2] ?? ""
  }
  const after = gap.length > 4 ? 1 : Math.max(gap.length, 1)
  return {
    ind: lead.length,
    ordered,
    marker,
    prefixW: stringWidth(marker) + 1,
    contentCol: lead.length + raw.length + after,
    content,
  }
}

function startsBlock(line: string): boolean {
  return matchFence(line) !== null || isHr(line) || matchHeading(line) !== null || QUOTE_RE.test(line) || matchItem(line) !== null
}

/**
 * Collects an item's body: indented lines (dedented by the content column) and lazy paragraph
 * continuations. Nested lists then fall out of the recursive render of the body.
 */
function renderList(lines: string[], i: number, width: number, depth: number, first: Item): Block {
  const out: Line[] = []
  let item = first
  let idx = i
  let next = i + 1
  for (;;) {
    const body: string[] = [item.content]
    let end = idx + 1
    let k = idx + 1
    while (k < lines.length) {
      const l = lines[k] ?? ""
      if (isBlank(l)) {
        k++
        continue
      }
      const lead = leadWidth(l)
      const include = lead > item.ind || (k === end && !startsBlock(l))
      if (!include) break
      while (end < k) {
        body.push("")
        end++
      }
      body.push(stripIndent(l, Math.min(lead, item.contentCol)))
      end = k + 1
      k++
    }
    next = end
    const bodyLines = renderBlocks(body, width - item.prefixW, depth + 1, true)
    if (bodyLines.length === 0) {
      out.push([{ text: item.marker }])
    } else {
      bodyLines.forEach((l, n) => {
        if (n === 0) out.push([{ text: `${item.marker} ` }, ...l])
        else out.push(l.length === 0 ? [] : [{ text: " ".repeat(item.prefixW) }, ...l])
      })
    }
    let q = end
    while (q < lines.length && isBlank(lines[q] ?? "")) q++
    const nxt = q < lines.length ? matchItem(lines[q] ?? "") : null
    if (!nxt || nxt.ind !== first.ind || nxt.ordered !== first.ordered || width - nxt.prefixW < MIN_INNER) break
    item = nxt
    idx = q
  }
  return { lines: out, next }
}

function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith("|")) s = s.slice(1)
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1)
  const cells: string[] = []
  let cur = ""
  for (let k = 0; k < s.length; k++) {
    const ch = s[k]
    if (ch === "\\" && s[k + 1] === "|") {
      cur += "|"
      k++
    } else if (ch === "|") {
      cells.push(cur.trim())
      cur = ""
    } else {
      cur += ch ?? ""
    }
  }
  cells.push(cur.trim())
  return cells
}

function isTableStart(lines: string[], i: number): boolean {
  const head = lines[i] ?? ""
  const delim = lines[i + 1]
  if (delim === undefined || !head.includes("|") || !delim.includes("-")) return false
  const h = splitRow(head)
  const d = splitRow(delim)
  return h.length === d.length && d.every((c) => DELIM_CELL.test(c))
}

function drawRow(cells: Span[][], colW: number[]): Line {
  const spans: Span[] = [{ text: "│" }]
  colW.forEach((w, c) => {
    const cell = cells[c] ?? []
    spans.push({ text: " " }, ...cell, { text: `${" ".repeat(w - lineWidth(cell))} │` })
  })
  return mergeSpans(spans)
}

/** Grid when it fits; otherwise every row becomes stacked "Header: value" lines. */
function renderTable(lines: string[], i: number, width: number): Block {
  const header = splitRow(lines[i] ?? "")
  const cols = header.length
  const rows: string[][] = []
  let j = i + 2
  while (j < lines.length) {
    const l = lines[j] ?? ""
    if (isBlank(l) || !l.includes("|")) break
    const r = splitRow(l)
    rows.push(Array.from({ length: cols }, (_, c) => r[c] ?? ""))
    j++
  }
  const head = header.map((h) => parseInline(h).map((s): Span => ({ ...s, bold: true })))
  const body = rows.map((r) => r.map((c) => parseInline(c)))
  const colW: number[] = []
  for (let c = 0; c < cols; c++) {
    let w = Math.max(1, lineWidth(head[c] ?? []))
    for (const r of body) w = Math.max(w, lineWidth(r[c] ?? []))
    colW.push(w)
  }
  const total = 1 + colW.reduce((a, w) => a + w + 3, 0)
  const out: Line[] = []
  if (total <= width) {
    out.push(drawRow(head, colW))
    out.push([{ text: `─${colW.map((w) => "─".repeat(w + 2)).join("┼")}─` }])
    for (const r of body) out.push(drawRow(r, colW))
    return { lines: out, next: j }
  }
  if (body.length === 0) {
    const joined: Span[] = []
    head.forEach((h, c) => {
      if (c > 0) joined.push({ text: " | " })
      for (const s of h) joined.push(s)
    })
    return { lines: wrapSpans(joined, width), next: j }
  }
  body.forEach((row, r) => {
    if (r > 0) out.push([])
    row.forEach((cell, c) => {
      const label = head[c] ?? []
      for (const l of wrapSpans([...label, { text: ": " }, ...cell], width, { firstIndent: [], indent: [{ text: "  " }] })) out.push(l)
    })
  })
  return { lines: out, next: j }
}

function interruptsParagraph(lines: string[], k: number): boolean {
  const l = lines[k] ?? ""
  if (matchFence(l) !== null || isHr(l) || matchHeading(l) !== null || QUOTE_RE.test(l)) return true
  const item = matchItem(l)
  // Like CommonMark: an empty item cannot interrupt, and an ordered item only when it starts at 1.
  if (item && item.content !== "" && (!item.ordered || item.marker === "1.")) return true
  return isTableStart(lines, k)
}

function renderParagraph(lines: string[], i: number, width: number): Block {
  let end = i + 1
  while (end < lines.length && !isBlank(lines[end] ?? "") && !interruptsParagraph(lines, end)) end++
  let raw = ""
  for (let k = i; k < end; k++) {
    const l = (lines[k] ?? "").replace(/^ +/, "")
    if (k === end - 1) {
      raw += l.trimEnd()
      break
    }
    // Two trailing spaces or a trailing backslash make a hard break; the inline parser keeps "\n" as text.
    const hard = l.endsWith("  ")
    const t = l.trimEnd()
    if (t.endsWith("\\")) raw += `${t.slice(0, -1)}\n`
    else raw += t + (hard ? "\n" : " ")
  }
  return { lines: wrapSpans(parseInline(raw), width), next: end }
}

// ---------------------------------------------------------------------------
// Inline level

type Tok =
  | { k: "text"; s: string; f?: Flags; dead: boolean }
  | { k: "delim"; s: string; dead: boolean }
  | { k: "bracket"; at: number; dead: boolean }

interface Range {
  a: number
  b: number
  fl: Flags
}

/**
 * Two passes: tokens with delimiter and bracket candidates are paired with per-marker stacks
 * (linear time), then each pair becomes a token range whose style is applied with a difference
 * array. Unpaired markers stay literal.
 */
function parseInline(src: string): Span[] {
  const toks: Tok[] = []
  const ranges: Range[] = []
  const brackets: number[] = []
  const stacks = new Map<string, number[]>()
  const noCloser = new Set<number>()
  const special = /[\\`<[\]*_~]/g
  const n = src.length
  // Text tokens may only merge with a token at or after this index; a range boundary sits before it.
  let barrier = 0
  let i = 0

  const addText = (s: string): void => {
    const last = toks[toks.length - 1]
    if (toks.length > barrier && last && last.k === "text" && !last.f && !last.dead) last.s += s
    else toks.push({ k: "text", s, dead: false })
  }

  while (i < n) {
    special.lastIndex = i
    const m = special.exec(src)
    if (m === null) {
      addText(src.slice(i))
      break
    }
    if (m.index > i) {
      addText(src.slice(i, m.index))
      i = m.index
    }
    const c = src[i] ?? ""

    if (c === "\\") {
      const nx = src[i + 1]
      if (nx !== undefined && ASCII_PUNCT.test(nx)) {
        addText(nx)
        i += 2
      } else {
        addText("\\")
        i += 1
      }
    } else if (c === "`") {
      let j = i
      while (src[j] === "`") j++
      const len = j - i
      const close = noCloser.has(len) ? -1 : findBacktickRun(src, j, len)
      if (close < 0) {
        noCloser.add(len)
        addText("`".repeat(len))
        i = j
      } else {
        toks.push({ k: "text", s: codeBody(src.slice(j, close)), f: { code: true, bold: true }, dead: false })
        i = close + len
      }
    } else if (c === "<") {
      AUTOLINK.lastIndex = i
      const am = AUTOLINK.exec(src)
      if (am) {
        toks.push({ k: "text", s: am[1] ?? "", f: { underline: true }, dead: false })
        i = AUTOLINK.lastIndex
      } else {
        addText("<")
        i += 1
      }
    } else if (c === "[") {
      brackets.push(toks.length)
      toks.push({ k: "bracket", at: i, dead: false })
      i += 1
    } else if (c === "]") {
      const open = brackets.pop()
      const ob = open === undefined ? undefined : toks[open]
      const end = ob && ob.k === "bracket" && src[i + 1] === "(" ? findLinkEnd(src, i + 2) : -1
      const url = end < 0 ? "" : (src.slice(i + 2, end).trim().split(SPACE)[0] ?? "")
      if (open !== undefined && ob && ob.k === "bracket" && url !== "") {
        ob.dead = true
        ranges.push({ a: open + 1, b: toks.length, fl: { underline: true } })
        barrier = toks.length
        // Show the destination only when it differs from the visible text.
        if (src.slice(ob.at + 1, i) !== url) toks.push({ k: "text", s: ` (${url})`, f: { dim: true }, dead: false })
        i = end + 1
      } else {
        addText("]")
        i += 1
      }
    } else {
      // * _ ~ runs
      let j = i
      while (src[j] === c) j++
      const len = j - i
      if (c === "~" ? len !== 2 : len > 3) {
        addText(src.slice(i, j))
        i = j
        continue
      }
      const prev = src[i - 1] ?? " "
      const next = src[j] ?? " "
      const prevWs = SPACE.test(prev)
      const nextWs = SPACE.test(next)
      const prevP = PUNCT.test(prev)
      const nextP = PUNCT.test(next)
      const left = !nextWs && (!nextP || prevWs || prevP)
      const right = !prevWs && (!prevP || nextWs || nextP)
      // Underscores inside a word (snake_case) never open or close emphasis.
      const canOpen = c === "_" ? left && (!right || prevP) : left
      const canClose = c === "_" ? right && (!left || nextP) : right
      const key = c + len
      const stack = stacks.get(key)
      if (canClose && stack && stack.length > 0) {
        const oi = stack.pop() ?? -1
        const ot = toks[oi]
        if (ot && ot.k === "delim") ot.dead = true
        ranges.push({ a: oi + 1, b: toks.length, fl: delimFlags(c, len) })
        barrier = toks.length
      } else if (canOpen) {
        const list = stacks.get(key) ?? []
        list.push(toks.length)
        stacks.set(key, list)
        toks.push({ k: "delim", s: src.slice(i, j), dead: false })
      } else {
        addText(src.slice(i, j))
      }
      i = j
    }
  }

  const N = toks.length
  const deltas = new Map<FlagKey, number[]>()
  for (const r of ranges) {
    for (const key of FLAG_KEYS) {
      if (!r.fl[key]) continue
      let arr = deltas.get(key)
      if (!arr) {
        arr = new Array<number>(N + 1).fill(0)
        deltas.set(key, arr)
      }
      arr[r.a] = (arr[r.a] ?? 0) + 1
      arr[r.b] = (arr[r.b] ?? 0) - 1
    }
  }
  const active: Record<FlagKey, number> = { bold: 0, italic: 0, dim: 0, underline: 0, inverse: 0, strikethrough: 0, code: 0 }
  const pieces: Span[] = []
  for (let k = 0; k < N; k++) {
    for (const key of FLAG_KEYS) {
      const arr = deltas.get(key)
      if (arr) active[key] += arr[k] ?? 0
    }
    const t = toks[k]
    if (!t || t.dead) continue
    const flags: Flags = t.k === "text" && t.f ? { ...t.f } : {}
    for (const key of FLAG_KEYS) if (active[key] > 0) flags[key] = true
    pieces.push({ ...flags, text: t.k === "bracket" ? "[" : t.s })
  }
  return mergeSpans(pieces)
}

function delimFlags(c: string, len: number): Flags {
  if (c === "~") return { strikethrough: true }
  if (len === 2) return { bold: true }
  if (len === 1) return { italic: true }
  return { bold: true, italic: true }
}

function codeBody(s: string): string {
  // One leading and trailing space are stripped when both are present (CommonMark).
  if (s.length >= 2 && s.startsWith(" ") && s.endsWith(" ") && s.trim() !== "") return s.slice(1, -1)
  return s
}

/** Index of the first backtick run of exactly `len` at or after `from`, or -1. */
function findBacktickRun(src: string, from: number, len: number): number {
  let p = src.indexOf("`", from)
  while (p >= 0) {
    let q = p
    while (src[q] === "`") q++
    if (q - p === len) return p
    p = src.indexOf("`", q)
  }
  return -1
}

/** Index of the ")" closing a link destination, bounded so repeated "](" stays linear. */
function findLinkEnd(src: string, from: number): number {
  const stop = Math.min(src.length, from + 2048)
  for (let p = from; p < stop; p++) {
    const ch = src[p]
    if (ch === ")") return p
    if (ch === "\n") return -1
  }
  return -1
}
