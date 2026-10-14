import { expect, test } from "bun:test"
import { lineWidth, linesToText, renderMarkdown, wrapSpans } from "../src/tui/markdown"
import type { Line, Span } from "../src/tui/markdown"

const text = (src: string, width = 80): string => linesToText(renderMarkdown(src, width))
const allWithin = (lines: Line[], width: number): boolean => lines.every((l) => lineWidth(l) <= width)
const hasDoubleBlank = (lines: Line[]): boolean =>
  lines.some((l, i) => l.length === 0 && lines[i - 1]?.length === 0)

/** Finds the first span whose text equals `t`. */
const span = (lines: Line[], t: string): Span | undefined => lines.flat().find((s) => s.text === t)

// --- paragraphs and breaks ---------------------------------------------------

test("soft line breaks join with a space", () => {
  expect(text("hello\nworld")).toBe("hello world")
})

test("two trailing spaces and a trailing backslash are hard breaks", () => {
  expect(renderMarkdown("a  \nb", 40).map((l) => l.map((s) => s.text).join(""))).toEqual(["a", "b"])
  expect(renderMarkdown("a\\\nb", 40).map((l) => l.map((s) => s.text).join(""))).toEqual(["a", "b"])
})

test("blocks are separated by exactly one blank line", () => {
  const lines = renderMarkdown("para one\n\n\n\npara two", 40)
  expect(linesToText(lines)).toBe("para one\n\npara two")
})

test("no leading, trailing or double blank lines", () => {
  const lines = renderMarkdown("\n\n# T\n\n\n\n- a\n\n\n- b\n\n\n", 40)
  expect(lines[0]?.length).toBeGreaterThan(0)
  expect(lines[lines.length - 1]?.length).toBeGreaterThan(0)
  expect(hasDoubleBlank(lines)).toBe(false)
})

test("CRLF input behaves like LF", () => {
  expect(text("a\r\nb\r\n\r\nc")).toBe("a b\n\nc")
  expect(text("a\rb")).toBe("a b")
})

// --- headings ----------------------------------------------------------------

test("h1 is bold and underlined, h2 and h3 are bold, and no # is printed", () => {
  const lines = renderMarkdown("# One\n\n## Two\n\n### Three", 40)
  expect(linesToText(lines)).toBe("One\n\nTwo\n\nThree")
  expect(span(lines, "One")).toEqual({ text: "One", bold: true, underline: true })
  expect(span(lines, "Two")).toEqual({ text: "Two", bold: true })
  expect(span(lines, "Three")).toEqual({ text: "Three", bold: true })
})

test("a heading without a space is a paragraph, and closing hashes are dropped", () => {
  expect(text("#tag")).toBe("#tag")
  expect(text("## Title ##")).toBe("Title")
  expect(text("C#")).toBe("C#")
})

// --- fenced code -------------------------------------------------------------

test("fenced code gets a dim gutter, code spans, and a dim info line", () => {
  const lines = renderMarkdown("```ts\nconst a = 1\n```", 40)
  expect(lines).toEqual([
    [{ text: "ts", dim: true }],
    [
      { text: "│ ", dim: true },
      { text: "const a = 1", code: true },
    ],
  ])
})

test("code tabs become two spaces and leading whitespace is kept", () => {
  expect(text("```\n\tx\n    y\n```")).toBe("│   x\n│     y")
})

test("long code lines hard-wrap with the gutter repeated", () => {
  const lines = renderMarkdown("```\nabcdefghijklmnop\n```", 10)
  expect(linesToText(lines)).toBe("│ abcdefgh\n│ ijklmnop")
  expect(allWithin(lines, 10)).toBe(true)
})

test("tilde fences work and a closing fence must be at least as long", () => {
  expect(text("~~~\nx\n~~~")).toBe("│ x")
  expect(text("````\n```\nstill code\n````")).toBe("│ ```\n│ still code")
})

test("an unterminated fence treats the rest of the input as code", () => {
  const lines = renderMarkdown("```js\nfoo\n\nbar **not bold**", 40)
  expect(linesToText(lines)).toBe("js\n│ foo\n│ \n│ bar **not bold**")
  expect(span(lines, "bar **not bold**")).toEqual({ text: "bar **not bold**", code: true })
})

test("a lone opening fence renders nothing rather than throwing", () => {
  expect(renderMarkdown("```", 40)).toEqual([])
  expect(text("```\n")).toBe("│ ")
})

// --- lists -------------------------------------------------------------------

test("unordered lists use bullets and ordered lists keep their numbers", () => {
  expect(text("- a\n* b\n+ c")).toBe("• a\n• b\n• c")
  expect(text("1. first\n2. second")).toBe("1. first\n2. second")
})

test("nested lists are indented by 2 or 4 spaces", () => {
  expect(text("- a\n  - b\n    - c")).toBe("• a\n  • b\n    • c")
  expect(text("- a\n    - b")).toBe("• a\n  • b")
})

test("wrapped list items use a hanging indent", () => {
  expect(text("- one two three four", 12)).toBe("• one two\n  three four")
  expect(text("1. one two three four", 12)).toBe("1. one two\n   three\n   four")
})

test("task list items render as checkboxes", () => {
  expect(text("- [ ] todo\n- [x] done\n- [X] also")).toBe("☐ todo\n☑ done\n☑ also")
})

test("a dash without a space and a hyphenated word are not list items", () => {
  expect(text("-foo")).toBe("-foo")
  expect(text("1.5 million")).toBe("1.5 million")
})

test("a list item with an empty body keeps its marker", () => {
  expect(text("-")).toBe("•")
})

// --- blockquotes and rules ---------------------------------------------------

test("blockquotes get a dim bar prefix", () => {
  const lines = renderMarkdown("> quoted", 40)
  expect(lines).toEqual([[{ text: "▎ ", dim: true }, { text: "quoted" }]])
})

test("nested blockquotes add one bar per level", () => {
  expect(text("> a\n> > b")).toBe("▎ a\n▎ \n▎ ▎ b")
})

test("blockquotes can contain lists", () => {
  expect(text("> - item")).toBe("▎ • item")
})

test("horizontal rules span the width as a dim line", () => {
  for (const src of ["---", "***", "___", "- - -"]) {
    const lines = renderMarkdown(src, 12)
    expect(linesToText(lines)).toBe("─".repeat(12))
    expect(lines[0]?.[0]).toEqual({ text: "─".repeat(12), dim: true })
  }
})

// --- tables ------------------------------------------------------------------

test("tables are drawn with box characters and a bold header", () => {
  const lines = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |", 40)
  expect(linesToText(lines)).toBe("│ a │ b │\n────┼────\n│ 1 │ 2 │")
  const header = lines[0] ?? []
  expect(header.filter((s) => s.bold).map((s) => s.text)).toEqual(["a", "b"])
  expect(lines[2]?.some((s) => s.bold)).toBe(false)
})

test("tables wider than the width fall back to stacked Header: value lines", () => {
  const lines = renderMarkdown("| Name | Summary |\n|---|---|\n| Alice | Something quite long to force the fallback |", 30)
  expect(allWithin(lines, 30)).toBe(true)
  const out = linesToText(lines)
  expect(out).toContain("Name: Alice")
  expect(out).toContain("Summary: Something quite")
  expect(span(lines, "Name")?.bold).toBe(true)
})

test("a table with no body rows still renders its header", () => {
  const lines = renderMarkdown("| a | b |\n|---|---|", 40)
  expect(linesToText(lines)).toBe("│ a │ b │\n────┼────")
})

test("a pipe line without a delimiter row is plain text", () => {
  expect(text("a | b")).toBe("a | b")
})

// --- inline styles -----------------------------------------------------------

test("bold with ** and __", () => {
  expect(renderMarkdown("**bold** and __also__", 40)[0]).toEqual([
    { text: "bold", bold: true },
    { text: " and " },
    { text: "also", bold: true },
  ])
})

test("italic with * and _", () => {
  expect(renderMarkdown("*it* and _this_", 40)[0]).toEqual([
    { text: "it", italic: true },
    { text: " and " },
    { text: "this", italic: true },
  ])
})

test("strikethrough with ~~", () => {
  expect(renderMarkdown("~~gone~~ kept", 40)[0]).toEqual([{ text: "gone", strikethrough: true }, { text: " kept" }])
})

test("bold italic with three markers", () => {
  expect(renderMarkdown("***both***", 40)[0]).toEqual([{ text: "both", bold: true, italic: true }])
})

test("snake_case and identifiers with underscores are not italicised", () => {
  expect(renderMarkdown("snake_case_name and my_var_2", 40)[0]).toEqual([{ text: "snake_case_name and my_var_2" }])
})

test("code spans are literal and carry code and bold flags", () => {
  expect(renderMarkdown("use `a*b*` here", 40)[0]).toEqual([
    { text: "use " },
    { text: "a*b*", code: true, bold: true },
    { text: " here" },
  ])
})

test("code span with a longer backtick fence and inner backtick", () => {
  expect(renderMarkdown("``a`b``", 40)[0]).toEqual([{ text: "a`b", code: true, bold: true }])
})

test("links are underlined and show the destination in dim", () => {
  expect(renderMarkdown("[site](https://x.y)", 80)[0]).toEqual([
    { text: "site", underline: true },
    { text: " (https://x.y)", dim: true },
  ])
})

test("a link whose text equals its url shows no suffix", () => {
  expect(renderMarkdown("[https://x.y](https://x.y)", 80)[0]).toEqual([{ text: "https://x.y", underline: true }])
})

test("bare autolinks are underlined", () => {
  expect(renderMarkdown("see <https://x.y/p>", 80)[0]).toEqual([{ text: "see " }, { text: "https://x.y/p", underline: true }])
})

test("backslash escapes produce literal punctuation", () => {
  expect(text("\\*not italic\\*")).toBe("*not italic*")
  expect(renderMarkdown("\\*not italic\\*", 40)[0]).toEqual([{ text: "*not italic*" }])
})

test("unbalanced markers stay literal", () => {
  expect(renderMarkdown("**unclosed bold", 40)[0]).toEqual([{ text: "**unclosed bold" }])
  expect(text("2 * 3 * 4")).toBe("2 * 3 * 4")
  expect(text("[no target] and `open")).toBe("[no target] and `open")
})

test("inline styles inside headings and lists keep their flags", () => {
  expect(renderMarkdown("- **x**", 40)[0]).toEqual([{ text: "• " }, { text: "x", bold: true }])
})

test("adjacent spans with identical flags are merged", () => {
  expect(renderMarkdown("plain \\* text", 40)[0]).toEqual([{ text: "plain * text" }])
  expect(renderMarkdown("**a**__b__", 40)[0]).toEqual([{ text: "ab", bold: true }])
})

// --- wrapping ----------------------------------------------------------------

test("wrapSpans word-wraps and keeps every character", () => {
  const lines = wrapSpans([{ text: "alpha beta gamma delta" }], 11)
  expect(allWithin(lines, 11)).toBe(true)
  expect(linesToText(lines)).toBe("alpha beta\ngamma delta")
})

test("wrapSpans hard-breaks a word longer than the width", () => {
  const word = "abcdefghijklmnopqrstuvwxyz"
  const lines = wrapSpans([{ text: word }], 10)
  expect(allWithin(lines, 10)).toBe(true)
  expect(lines.map((l) => l.map((s) => s.text).join("")).join("")).toBe(word)
})

test("wrapSpans keeps styles across a break", () => {
  const lines = wrapSpans([{ text: "aaa bbb", bold: true }], 4)
  expect(lines).toEqual([[{ text: "aaa", bold: true }], [{ text: "bbb", bold: true }]])
})

test("wrapSpans applies firstIndent to line one and indent to the rest", () => {
  const lines = wrapSpans([{ text: "aaa bbb ccc" }], 6, { firstIndent: [{ text: "- " }], indent: [{ text: "  " }] })
  expect(linesToText(lines)).toBe("- aaa\n  bbb\n  ccc")
})

test("CJK: a long Korean sentence wraps within width without losing characters", () => {
  const src = "안녕하세요 여러분 오늘은 날씨가 정말 좋네요 그래서 산책을 나가고 싶어요 모두 함께 가요"
  const lines = renderMarkdown(src, 20)
  expect(allWithin(lines, 20)).toBe(true)
  expect(lines.length).toBeGreaterThan(1)
  const joined = linesToText(lines).replace(/\s/g, "")
  expect(joined).toBe(src.replace(/\s/g, ""))
})

test("CJK: an unbroken Korean run hard-breaks between wide characters", () => {
  const src = "가나다라마바사아자차카타파하가나다라마바사아자차카타파하"
  const lines = renderMarkdown(src, 20)
  expect(allWithin(lines, 20)).toBe(true)
  expect(linesToText(lines).replace(/\n/g, "")).toBe(src)
})

test("CJK: mixed Korean and Latin text wraps at width", () => {
  const src = "Deberopa는 터미널에서 동작하는 AI 코딩 에이전트입니다 with English words"
  const lines = renderMarkdown(src, 16)
  expect(allWithin(lines, 16)).toBe(true)
  expect(linesToText(lines).replace(/\s/g, "")).toBe(src.replace(/\s/g, ""))
})

test("emoji count as two cells", () => {
  expect(lineWidth([{ text: "👍" }])).toBe(2)
  expect(lineWidth([{ text: "👨‍👩‍👧" }])).toBe(2)
  const lines = renderMarkdown("👍".repeat(10), 10)
  expect(allWithin(lines, 10)).toBe(true)
  expect(linesToText(lines).replace(/\n/g, "")).toBe("👍".repeat(10))
})

test("lineWidth measures Hangul and ASCII", () => {
  expect(lineWidth([{ text: "안녕" }, { text: " hi" }])).toBe(7)
})

test("widths below 10 are clamped to 10", () => {
  const lines = renderMarkdown("abcdefghijklmnopqrstuvwxyz and more words here", 3)
  expect(allWithin(lines, 10)).toBe(true)
  expect(lines.length).toBeGreaterThan(1)
})

test("a huge or NaN width does not throw", () => {
  expect(() => renderMarkdown("x".repeat(100), Number.POSITIVE_INFINITY)).not.toThrow()
  expect(() => renderMarkdown("---", Number.NaN)).not.toThrow()
})

test("long wrapped paragraph never exceeds the width", () => {
  const src = "The quick brown fox jumps over the lazy dog. ".repeat(20)
  for (const w of [10, 17, 33, 80]) expect(allWithin(renderMarkdown(src, w), w)).toBe(true)
})

// --- robustness --------------------------------------------------------------

test("malformed and pathological input never throws", () => {
  const inputs = [
    "```",
    "~~~~",
    "> > > > > > > > > > > > > > > > > > > > > > > > > > > > > > > > > > > > > > > > > > > > > > > > x",
    "- ".repeat(500),
    "1. ".repeat(300),
    "|",
    "| | |\n|-|-|\n|",
    "[](",
    "](](](",
    "**".repeat(2000),
    "*".repeat(5000),
    "[".repeat(5000),
    "`".repeat(3000),
    "<".repeat(3000),
    "\u001b[31mred\u001b[0m",
    "\u0000\u0007\u0008 text",
    "#".repeat(1000),
    "# ".repeat(200),
    "   ",
    "\n\n\n",
    "| a |\n| b |\n|--|",
    "- [ ]",
    "--- ***",
  ]
  for (const src of inputs) {
    for (const w of [1, 10, 40]) {
      const lines = renderMarkdown(src, w)
      expect(allWithin(lines, Math.max(10, w))).toBe(true)
      expect(hasDoubleBlank(lines)).toBe(false)
    }
  }
})

test("ANSI escape bytes in the source are stripped", () => {
  expect(text("\u001b[31mred\u001b[0m")).toBe("[31mred[0m")
})

test("a 50k character document renders in linear-ish time", () => {
  const block = "## Heading\n\nSome **bold** text with `code` and a [link](https://example.com/x).\n\n- item one\n- item two\n\n```ts\nconst x = 1\n```\n\n"
  const src = block.repeat(Math.ceil(50_000 / block.length))
  const started = performance.now()
  const lines = renderMarkdown(src, 80)
  const elapsed = performance.now() - started
  expect(lines.length).toBeGreaterThan(100)
  expect(elapsed).toBeLessThan(5000)
})

test("fuzz: 200 random slices of a mixed document never throw and never exceed the width", () => {
  const doc = [
    "# Title with `code` and **bold**",
    "",
    "Intro paragraph with *emphasis*, a [link](https://example.com/a/b) and <https://x.y>.",
    "Hard break here  ",
    "next line\\",
    "continues. 한국어 문장도 섞여 있고 이모지 👍🏽 also present.",
    "",
    "- bullet with a long line that should wrap nicely across the width given to the renderer",
    "  - nested child with **bold** 한글 텍스트 텍스트 텍스트",
    "    - deeper 👨‍👩‍👧 family",
    "1. ordered one",
    "2. ordered two",
    "- [ ] task open",
    "- [x] task done",
    "",
    "> quote line one with some words that need wrapping in narrow columns",
    "> > nested quote 안녕하세요 안녕하세요",
    "",
    "```typescript",
    "function f(a: number): number { return a * 2 }   // a very long comment line that keeps going and going",
    "\tindented with tab",
    "```",
    "",
    "| Column A | Column B | 긴 헤더 |",
    "|:---|---:|---|",
    "| alpha | 1 | 값 하나 |",
    "| beta | 22 | 값 둘 |",
    "",
    "***",
    "Trailing text without a closing fence:",
    "```",
    "unterminated code 한글 with a very long line that must hard wrap across several rows",
  ].join("\n")

  // Deterministic PRNG (mulberry32) so failures reproduce.
  let seed = 0x5eed
  const rand = (): number => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = seed
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  for (let k = 0; k < 200; k++) {
    const a = Math.floor(rand() * doc.length)
    const b = k % 2 === 0 ? doc.length : Math.min(doc.length, a + Math.floor(rand() * 400))
    const slice = doc.slice(a, Math.max(a, b))
    const width = 10 + Math.floor(rand() * 60)
    let lines: Line[] = []
    expect(() => {
      lines = renderMarkdown(slice, width)
    }).not.toThrow()
    expect(allWithin(lines, width)).toBe(true)
    expect(hasDoubleBlank(lines)).toBe(false)
  }
})
