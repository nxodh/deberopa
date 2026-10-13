import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, describe, expect, test } from "bun:test"
import type { PermissionRequest, ToolContext } from "../src/tool/tool"

// Must be set before any project module that computes Paths is imported.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "vedecaps-test-"))
process.env.VEDECAPS_HOME = home

const { htmlToMarkdown, htmlToText } = await import("../src/util/html")
const { WebFetchTool } = await import("../src/tool/webfetch")
const { TodoWriteTool, TodoReadTool, getTodos } = await import("../src/tool/todo")
const { subscribe } = await import("../src/util/bus")
const { ToolInputError } = await import("../src/tool/tool")

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13])
const MAX_BYTES = 5 * 1024 * 1024

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const { pathname } = new URL(req.url)
    switch (pathname) {
      case "/page":
        return new Response(
          '<html><head><title>x</title><script>var a = 1</script></head><body><h1>Hello</h1><p>Read <a href="/docs">the docs</a>.</p></body></html>',
          { headers: { "content-type": "text/html; charset=utf-8" } },
        )
      case "/text":
        return new Response("plain body", { headers: { "content-type": "text/plain" } })
      case "/image":
        return new Response(PNG_BYTES, { headers: { "content-type": "image/png" } })
      case "/big":
        return new Response(new Uint8Array(MAX_BYTES + 1), { headers: { "content-type": "application/octet-stream" } })
      case "/missing":
        return new Response("nope", { status: 404 })
      default:
        return new Response("not found", { status: 404 })
    }
  },
})
const base = `http://127.0.0.1:${server.port}`

afterAll(() => {
  server.stop(true)
  fs.rmSync(home, { recursive: true, force: true })
})

function makeCtx(asked: PermissionRequest[]): ToolContext {
  return {
    sessionID: "s",
    messageID: "m",
    callID: "c",
    agent: "build",
    abort: new AbortController().signal,
    directory: home,
    worktree: home,
    ask: async (r) => {
      asked.push(r)
    },
    metadata: () => {},
  }
}

describe("htmlToMarkdown", () => {
  test("headings", () => {
    expect(htmlToMarkdown("<h1>Title</h1><h2>Sub &amp; more</h2>")).toBe("# Title\n\n## Sub & more")
  })

  test("links keep text and href, skip javascript: and empty text", () => {
    const md = htmlToMarkdown(
      '<p>See <a href="https://example.com/a">the docs</a> and <a href="javascript:alert(1)">bad</a>.</p>',
    )
    expect(md).toBe("See [the docs](https://example.com/a) and bad.")
    expect(htmlToMarkdown('<p>x<a href="https://e.com"> </a>y</p>')).not.toContain("[")
  })

  test("nested lists are indented under their item", () => {
    expect(htmlToMarkdown("<ul><li>A<ul><li>A1</li><li>A2</li></ul></li><li>B</li></ul>")).toBe(
      "- A\n  - A1\n  - A2\n- B",
    )
  })

  test("ordered lists are numbered", () => {
    expect(htmlToMarkdown("<ol><li>one</li><li>two</li></ol>")).toBe("1. one\n2. two")
  })

  test("pre with language class becomes a fenced block that keeps whitespace", () => {
    expect(htmlToMarkdown('<pre><code class="language-ts">const a = 1;\n  return a;</code></pre>')).toBe(
      "```ts\nconst a = 1;\n  return a;\n```",
    )
  })

  test("inline code", () => {
    expect(htmlToMarkdown("<p>Use <code>bun test</code> now</p>")).toBe("Use `bun test` now")
  })

  test("table becomes a GFM pipe table", () => {
    const html =
      "<table><thead><tr><th>Name</th><th>Qty</th></tr></thead>" +
      "<tbody><tr><td>apple</td><td>2</td></tr></tbody></table>"
    expect(htmlToMarkdown(html)).toBe("| Name | Qty |\n| --- | --- |\n| apple | 2 |")
  })

  test("entities are decoded", () => {
    expect(htmlToMarkdown("<p>&lt;b&gt; &quot;q&quot; a&nbsp;b &mdash; &#65; &#x1F600;</p>")).toBe(
      '<b> "q" a b — A \u{1F600}',
    )
  })

  test("script, style and comments are stripped", () => {
    const html = '<style>p{color:red}</style><script>alert("x")</script><!-- secret --><p>Hi</p>'
    expect(htmlToMarkdown(html)).toBe("Hi")
  })
})

describe("htmlToText", () => {
  test("plain text without markdown syntax", () => {
    expect(
      htmlToText('<h1>T</h1><p>Some <b>bold</b> and <a href="https://a.b">link</a>.</p><ul><li>x</li></ul>'),
    ).toBe("T\n\nSome bold and link (https://a.b).\n\n- x")
  })
})

describe("WebFetchTool", () => {
  test("html is converted to markdown by default", async () => {
    const asked: PermissionRequest[] = []
    const result = await WebFetchTool.execute({ url: base + "/page" }, makeCtx(asked))
    expect(result.output).toBe("# Hello\n\nRead [the docs](/docs).")
    expect(result.title).toBe(`${base}/page (text/html)`)
    expect(result.metadata).toMatchObject({ status: 200, contentType: "text/html", truncated: false })
  })

  test("format text", async () => {
    const result = await WebFetchTool.execute({ url: base + "/page", format: "text" }, makeCtx([]))
    expect(result.output).toBe("Hello\n\nRead the docs.")
  })

  test("format html returns the raw source", async () => {
    const result = await WebFetchTool.execute({ url: base + "/page", format: "html" }, makeCtx([]))
    expect(result.output).toContain("<h1>Hello</h1>")
    expect(result.output).toContain("<script>var a = 1</script>")
  })

  test("non-html text is returned as is", async () => {
    const result = await WebFetchTool.execute({ url: base + "/text", format: "markdown" }, makeCtx([]))
    expect(result.output).toBe("plain body")
  })

  test("non-2xx status is an error", async () => {
    await expect(WebFetchTool.execute({ url: base + "/missing" }, makeCtx([]))).rejects.toThrow(
      "Request failed with status code: 404",
    )
  })

  test("image is returned as an attachment", async () => {
    const result = await WebFetchTool.execute({ url: base + "/image" }, makeCtx([]))
    expect(result.output).toBe("Image fetched successfully")
    expect(result.attachments?.[0]?.mime).toBe("image/png")
    expect(Buffer.from(result.attachments?.[0]?.data ?? "", "base64")).toEqual(Buffer.from(PNG_BYTES))
  })

  test("bodies over 5 MB are rejected", async () => {
    await expect(WebFetchTool.execute({ url: base + "/big" }, makeCtx([]))).rejects.toThrow(/too large/i)
  })

  test("invalid URL scheme is rejected before asking permission", async () => {
    const asked: PermissionRequest[] = []
    await expect(WebFetchTool.execute({ url: "ftp://example.com/file" }, makeCtx(asked))).rejects.toBeInstanceOf(
      ToolInputError,
    )
    expect(asked).toHaveLength(0)
  })

  test("asks for webfetch permission with the origin as the always-pattern", async () => {
    const asked: PermissionRequest[] = []
    await WebFetchTool.execute({ url: base + "/text" }, makeCtx(asked))
    expect(asked[0]?.permission).toBe("webfetch")
    expect(asked[0]?.patterns).toEqual([base + "/text"])
    expect(asked[0]?.always).toEqual([base + "/*"])
  })
})

describe("todo tools", () => {
  test("write then read round trip, with id assignment and default priority", async () => {
    const ctx = makeCtx([])
    await TodoWriteTool.execute(
      {
        todos: [
          { content: "first", status: "in_progress" },
          { content: "second", status: "pending", priority: "high", id: "x" },
          { content: "third", status: "pending" },
        ],
      },
      ctx,
    )
    const stored = await getTodos("s")
    expect(stored.map((t) => t.id)).toEqual(["1", "x", "3"])
    expect(stored[0]?.priority).toBe("medium")
    expect(stored[1]?.priority).toBe("high")

    const read = await TodoReadTool.execute({}, ctx)
    expect(JSON.parse(read.output)).toEqual(stored)
    expect(read.metadata).toEqual({ todos: stored })
  })

  test("write replaces the whole list", async () => {
    const ctx = makeCtx([])
    await TodoWriteTool.execute({ todos: [{ content: "a", status: "pending" }, { content: "b", status: "pending" }] }, ctx)
    await TodoWriteTool.execute({ todos: [{ content: "c", status: "pending" }] }, ctx)
    expect((await getTodos("s")).map((t) => t.content)).toEqual(["c"])
  })

  test("title counts items that are not completed or cancelled", async () => {
    const result = await TodoWriteTool.execute(
      {
        todos: [
          { content: "a", status: "completed" },
          { content: "b", status: "cancelled" },
          { content: "c", status: "pending" },
          { content: "d", status: "in_progress" },
        ],
      },
      makeCtx([]),
    )
    expect(result.title).toBe("2 todos")
  })

  test("setTodos publishes todo.updated", async () => {
    const events: Array<{ sessionID: string; todos: unknown[] }> = []
    const off = subscribe<{ sessionID: string; todos: unknown[] }>("todo.updated", (e) => {
      events.push(e.properties)
    })
    await TodoWriteTool.execute({ todos: [{ content: "a", status: "pending" }] }, makeCtx([]))
    off()
    expect(events).toHaveLength(1)
    expect(events[0]?.sessionID).toBe("s")
    expect(events[0]?.todos).toHaveLength(1)
  })
})
