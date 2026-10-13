import { expect, test } from "bun:test"
import * as E from "../src/tui/editor"
import { fuzzyFilter, fuzzyScore } from "../src/tui/fuzzy"

const at = (text: string, cursor = text.length): E.EditorState => ({ text, cursor })

test("insert, backspace and delete respect grapheme clusters", () => {
  let s = E.insert(E.empty(), "안녕")
  expect(s).toEqual({ text: "안녕", cursor: 2 })
  s = E.insert(s, "👨‍👩‍👧")
  s = E.backspace(s)
  expect(s.text).toBe("안녕")
  s = E.deleteForward(E.left(E.left(s)))
  expect(s).toEqual({ text: "녕", cursor: 0 })
  expect(E.backspace(at("", 0))).toEqual({ text: "", cursor: 0 })
})

test("pasted text is normalised", () => {
  expect(E.insert(E.empty(), "a\r\nb\rc\td").text).toBe("a\nb\nc  d")
})

test("word and line motion", () => {
  const s = at("git commit -m msg", 17)
  expect(E.wordLeft(s).cursor).toBe(14)
  expect(E.wordLeft(E.wordLeft(s)).cursor).toBe(11)
  expect(E.wordRight(at("git commit", 0)).cursor).toBe(3)
  const multi = at("one\ntwo three\nfour", 8)
  expect(E.lineStart(multi).cursor).toBe(4)
  expect(E.lineEnd(multi).cursor).toBe(13)
  expect(E.killToLineEnd(multi).text).toBe("one\ntwo \nfour")
  expect(E.killToLineStart(multi).text).toBe("one\nthree\nfour")
  expect(E.killWordBack(at("hello world")).text).toBe("hello ")
})

test("layout wraps by terminal cells, so wide characters count double", () => {
  const l = E.layout(at("가나다라마바사"), 6)
  expect(l.rows.map((r) => r.text)).toEqual(["가나다", "라마바", "사"])
  expect(l.cursorRow).toBe(2)
  expect(l.cursorCol).toBe(2)
  const mid = E.layout(at("가나다라마바사", 3), 6)
  // a cursor on a soft-wrap point sits at the start of the following row
  expect([mid.cursorRow, mid.cursorCol]).toEqual([1, 0])
  const hard = E.layout(at("ab\ncd", 2), 10)
  expect([hard.cursorRow, hard.cursorCol]).toEqual([0, 2])
  expect(E.layout(at("", 0), 10)).toEqual({ rows: [{ text: "", start: 0, end: 0 }], cursorRow: 0, cursorCol: 0 })
})

test("vertical motion keeps the column and reports the edges", () => {
  const s = at("abcdef\nxy\nlonger line", 4)
  const down = E.vertical(s, 40, 1)!
  expect(down.cursor).toBe(9) // clamped to the end of "xy"
  expect(E.vertical(s, 40, -1)).toBeUndefined()
  expect(E.vertical(at("one", 1), 40, 1)).toBeUndefined()
  const wrapped = E.vertical(at("가나다라마바", 6), 6, -1)!
  expect(wrapped.cursor).toBe(3)
})

test("token detection for completions", () => {
  expect(E.tokenAtCursor(at("/mod"))).toEqual({ kind: "command", query: "mod", start: 0 })
  expect(E.tokenAtCursor(at("/models now"))).toBeUndefined()
  expect(E.tokenAtCursor(at("look at @src/in"))).toEqual({ kind: "file", query: "src/in", start: 8 })
  expect(E.tokenAtCursor(at("mail a@b"))).toBeUndefined()
  expect(E.replaceToken(at("look at @src/in"), 8, "@src/index.ts ").text).toBe("look at @src/index.ts ")
})

test("fuzzy matching ranks file-name hits first", () => {
  expect(fuzzyScore("xyz", "src/index.ts")).toBeUndefined()
  const files = ["src/session/prompt.ts", "src/tui/prompt.tsx", "docs/prompting.md", "src/provider/openai.ts"]
  expect(fuzzyFilter("prompt", files, (f) => f)[0]).toContain("prompt")
  expect(fuzzyFilter("opai", files, (f) => f)).toEqual(["src/provider/openai.ts"])
  expect(fuzzyFilter("", files, (f) => f, 2)).toHaveLength(2)
})
