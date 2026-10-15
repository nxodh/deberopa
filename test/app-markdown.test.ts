import { expect, test } from "bun:test"
import { parseBlocks, parseInline } from "../app/src/markdown"

test("inline code, bold and http(s) links; other link schemes stay text", () => {
  expect(parseInline("use `npm test` and **be careful** see [docs](https://example.com/a)")).toEqual([
    { t: "text", v: "use " },
    { t: "code", v: "npm test" },
    { t: "text", v: " and " },
    { t: "bold", v: "be careful" },
    { t: "text", v: " see " },
    { t: "link", v: "docs", href: "https://example.com/a" },
  ])
  expect(parseInline("[x](javascript:alert(1))")).toEqual([{ t: "text", v: "[x](javascript:alert(1))" }])
  expect(parseInline("<img src=x onerror=alert(1)>")).toEqual([{ t: "text", v: "<img src=x onerror=alert(1)>" }])
})

test("headings, lists, paragraphs and code fences become blocks", () => {
  const blocks = parseBlocks("# Title\n\nSome text\nsecond line\n\n- one\n- two\n\n1. first\n2. second\n\n```ts\nconst a = 1\n```\n")
  expect(blocks.map((b) => b.t)).toEqual(["heading", "p", "list", "list", "code"])
  expect(blocks[2]).toMatchObject({ t: "list", ordered: false })
  expect((blocks[2] as any).items.length).toBe(2)
  expect(blocks[3]).toMatchObject({ t: "list", ordered: true })
  expect(blocks[4]).toEqual({ t: "code", lang: "ts", v: "const a = 1" })
  // a paragraph keeps its line break
  expect((blocks[1] as any).inline[0].v).toBe("Some text\nsecond line")
})

test("an unfinished code fence (a streaming reply) runs to the end", () => {
  expect(parseBlocks("Here:\n```py\nprint(1)\nprint(")).toEqual([
    { t: "p", inline: [{ t: "text", v: "Here:" }] },
    { t: "code", lang: "py", v: "print(1)\nprint(" },
  ])
})
