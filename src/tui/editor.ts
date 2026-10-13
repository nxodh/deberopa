import stringWidth from "string-width"

/** Text buffer for the prompt. `cursor` is a UTF-16 offset that always sits on a grapheme boundary. */
export interface EditorState {
  text: string
  cursor: number
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

function graphemes(text: string): { segment: string; index: number }[] {
  return [...segmenter.segment(text)].map((s) => ({ segment: s.segment, index: s.index }))
}

export const empty = (): EditorState => ({ text: "", cursor: 0 })

export function insert(state: EditorState, value: string): EditorState {
  // Terminals send \r for Enter inside pastes; tabs would break the column maths.
  const clean = value.replace(/\r\n?/g, "\n").replace(/\t/g, "  ")
  return { text: state.text.slice(0, state.cursor) + clean + state.text.slice(state.cursor), cursor: state.cursor + clean.length }
}

function previousBoundary(text: string, cursor: number): number {
  let previous = 0
  for (const g of graphemes(text)) {
    if (g.index >= cursor) break
    previous = g.index
  }
  return previous
}

function nextBoundary(text: string, cursor: number): number {
  for (const g of graphemes(text)) {
    const end = g.index + g.segment.length
    if (end > cursor) return end
  }
  return text.length
}

export function backspace(state: EditorState): EditorState {
  if (state.cursor === 0) return state
  const start = previousBoundary(state.text, state.cursor)
  return { text: state.text.slice(0, start) + state.text.slice(state.cursor), cursor: start }
}

export function deleteForward(state: EditorState): EditorState {
  if (state.cursor >= state.text.length) return state
  const end = nextBoundary(state.text, state.cursor)
  return { text: state.text.slice(0, state.cursor) + state.text.slice(end), cursor: state.cursor }
}

export const left = (s: EditorState): EditorState => ({ ...s, cursor: s.cursor === 0 ? 0 : previousBoundary(s.text, s.cursor) })
export const right = (s: EditorState): EditorState => ({ ...s, cursor: nextBoundary(s.text, s.cursor) })

export function wordLeft(s: EditorState): EditorState {
  let i = s.cursor
  while (i > 0 && /\s/.test(s.text[i - 1]!)) i--
  while (i > 0 && !/\s/.test(s.text[i - 1]!)) i--
  return { ...s, cursor: i }
}

export function wordRight(s: EditorState): EditorState {
  let i = s.cursor
  while (i < s.text.length && /\s/.test(s.text[i]!)) i++
  while (i < s.text.length && !/\s/.test(s.text[i]!)) i++
  return { ...s, cursor: i }
}

export function lineStart(s: EditorState): EditorState {
  return { ...s, cursor: s.text.lastIndexOf("\n", s.cursor - 1) + 1 }
}

export function lineEnd(s: EditorState): EditorState {
  const next = s.text.indexOf("\n", s.cursor)
  return { ...s, cursor: next === -1 ? s.text.length : next }
}

export function killToLineEnd(s: EditorState): EditorState {
  const end = lineEnd(s).cursor
  // on an empty remainder, join with the next line like readline does
  const cut = end === s.cursor && end < s.text.length ? end + 1 : end
  return { text: s.text.slice(0, s.cursor) + s.text.slice(cut), cursor: s.cursor }
}

export function killToLineStart(s: EditorState): EditorState {
  const start = lineStart(s).cursor
  return { text: s.text.slice(0, start) + s.text.slice(s.cursor), cursor: start }
}

export function killWordBack(s: EditorState): EditorState {
  const start = wordLeft(s).cursor
  return { text: s.text.slice(0, start) + s.text.slice(s.cursor), cursor: start }
}

export interface Row {
  text: string
  /** Offset of the row's first character in the buffer. */
  start: number
  /** Offset just past the row's last character (excluding a trailing newline). */
  end: number
}

export interface Layout {
  rows: Row[]
  cursorRow: number
  /** Cursor column in terminal cells. */
  cursorCol: number
}

/** Break the buffer into visual rows of at most `width` cells, and locate the cursor among them. */
export function layout(state: EditorState, width: number): Layout {
  const max = Math.max(4, width)
  const rows: Row[] = []
  let offset = 0
  for (const line of state.text.split("\n")) {
    let rowStart = offset
    let rowText = ""
    let rowWidth = 0
    for (const g of graphemes(line)) {
      const w = stringWidth(g.segment)
      if (rowWidth + w > max && rowText !== "") {
        rows.push({ text: rowText, start: rowStart, end: offset + g.index })
        rowStart = offset + g.index
        rowText = ""
        rowWidth = 0
      }
      rowText += g.segment
      rowWidth += w
    }
    rows.push({ text: rowText, start: rowStart, end: offset + line.length })
    offset += line.length + 1
  }

  let cursorRow = rows.length - 1
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    const next = rows[i + 1]
    // A cursor at a soft-wrap point belongs to the start of the next row.
    if (state.cursor >= row.start && (state.cursor < row.end || (state.cursor === row.end && (!next || next.start !== row.end)))) {
      cursorRow = i
      break
    }
  }
  const row = rows[cursorRow]!
  const cursorCol = stringWidth(state.text.slice(row.start, Math.min(state.cursor, row.end)))
  return { rows, cursorRow, cursorCol }
}

function offsetAtColumn(row: Row, column: number): number {
  let width = 0
  for (const g of graphemes(row.text)) {
    const w = stringWidth(g.segment)
    if (width + w > column) return row.start + g.index
    width += w
  }
  return row.end
}

/** Move one visual row up or down. Returns undefined at the edge (callers then walk history). */
export function vertical(state: EditorState, width: number, direction: -1 | 1): EditorState | undefined {
  const l = layout(state, width)
  const target = l.rows[l.cursorRow + direction]
  if (!target) return undefined
  return { ...state, cursor: offsetAtColumn(target, l.cursorCol) }
}

/** The `@mention` or `/command` token the cursor is inside, if any. */
export function tokenAtCursor(state: EditorState): { kind: "file" | "command"; query: string; start: number } | undefined {
  const before = state.text.slice(0, state.cursor)
  if (/^\/[^\s]*$/.test(before)) return { kind: "command", query: before.slice(1), start: 0 }
  const at = /(?:^|\s)@([^\s@]*)$/.exec(before)
  if (at) return { kind: "file", query: at[1] ?? "", start: state.cursor - (at[1] ?? "").length - 1 }
  return undefined
}

export function replaceToken(state: EditorState, start: number, replacement: string): EditorState {
  const text = state.text.slice(0, start) + replacement + state.text.slice(state.cursor)
  return { text, cursor: start + replacement.length }
}
