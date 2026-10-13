import { htmlToMarkdown, htmlToText } from "../util/html"
import { defineTool, ToolInputError, truncateOutput } from "./tool"

const MAX_BYTES = 5 * 1024 * 1024
const DEFAULT_TIMEOUT_SECONDS = 30
const MAX_TIMEOUT_SECONDS = 120
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

interface WebFetchArgs {
  url: string
  format?: "markdown" | "text" | "html"
  timeout?: number
}

function parseUrl(raw: string): { href: string; origin: string } {
  const href = raw.trim()
  if (!/^https?:\/\//i.test(href)) {
    throw new ToolInputError(`URL must start with http:// or https://: ${raw}`)
  }
  try {
    const parsed = new URL(href)
    return { href, origin: parsed.origin }
  } catch {
    throw new ToolInputError(`Invalid URL: ${raw}`)
  }
}

function tooLarge(): Error {
  return new Error(`Response is too large (limit ${MAX_BYTES / 1024 / 1024} MB)`)
}

/** Read the body while enforcing the size cap, so a missing or wrong content-length cannot exhaust memory. */
async function readBody(res: Response): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > MAX_BYTES) throw tooLarge()
  if (!res.body) return new Uint8Array()
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_BYTES) {
      await reader.cancel()
      throw tooLarge()
    }
    chunks.push(value)
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

function decodeText(body: Uint8Array, contentType: string): string {
  const charset = /charset=([^;]+)/i.exec(contentType)?.[1]?.trim().replace(/["']/g, "")
  try {
    return new TextDecoder(charset || "utf-8").decode(body)
  } catch {
    // Unknown charset label: fall back to UTF-8 rather than failing the fetch.
    return new TextDecoder("utf-8").decode(body)
  }
}

export const WebFetchTool = defineTool<WebFetchArgs>({
  id: "webfetch",
  description: [
    "Fetch the content of an http:// or https:// URL. Use it when you already know the address you need.",
    "HTML pages are converted to Markdown by default; use format \"text\" for plain text or \"html\" for the raw source.",
    "Other text content is returned as is. Images are returned as attachments.",
    "Responses over 5 MB are rejected, and output is truncated when it is very long.",
    "This tool does not search the web. Requests that fail with a non-2xx status are reported as errors.",
  ].join("\n"),
  parameters: {
    type: "object",
    required: ["url"],
    properties: {
      url: {
        type: "string",
        description: "The full URL to fetch. Must start with http:// or https://.",
      },
      format: {
        type: "string",
        enum: ["markdown", "text", "html"],
        description: "Output format for HTML pages: markdown (default), text, or html (raw source).",
      },
      timeout: {
        type: "number",
        description: "Timeout in seconds. Default 30, maximum 120.",
        maximum: MAX_TIMEOUT_SECONDS,
      },
    },
  },
  async execute(args, ctx) {
    const { href: url, origin } = parseUrl(args.url)
    const format = args.format ?? "markdown"
    const seconds =
      typeof args.timeout === "number" && args.timeout > 0
        ? Math.min(args.timeout, MAX_TIMEOUT_SECONDS)
        : DEFAULT_TIMEOUT_SECONDS

    await ctx.ask({
      permission: "webfetch",
      patterns: [url],
      always: [origin + "/*"],
      title: "Fetch " + url,
      metadata: { url, format },
    })

    const timeout = AbortSignal.timeout(seconds * 1000)
    const signal = AbortSignal.any([ctx.abort, timeout])
    let res: Response
    let body: Uint8Array
    try {
      res = await fetch(url, {
        signal,
        redirect: "follow",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/markdown, text/html;q=0.9, text/plain;q=0.8, */*;q=0.5",
          "Accept-Language": "en-US,en;q=0.9",
        },
      })
      if (!res.ok) throw new Error("Request failed with status code: " + res.status)
      body = await readBody(res)
    } catch (err) {
      if (timeout.aborted && !ctx.abort.aborted) throw new Error(`Request timed out after ${seconds} seconds`)
      throw err
    }

    const rawContentType = res.headers.get("content-type") ?? ""
    const contentType = rawContentType.split(";")[0]?.trim().toLowerCase() || "unknown"
    const title = `${url} (${contentType})`

    if (contentType.startsWith("image/") && contentType !== "image/svg+xml") {
      return {
        title,
        output: "Image fetched successfully",
        attachments: [{ mime: contentType, data: Buffer.from(body).toString("base64") }],
      }
    }

    if (/^(application\/(pdf|zip|gzip|octet-stream|x-tar|wasm)|audio\/|video\/|font\/)/.test(contentType)) {
      throw new Error(`Cannot display ${contentType} content (${body.byteLength} bytes). Download it with a shell command instead.`)
    }
    const text = decodeText(body, rawContentType)
    let output = text
    if (contentType.includes("text/html")) {
      if (format === "markdown") output = htmlToMarkdown(text)
      else if (format === "text") output = htmlToText(text)
    }
    const truncated = truncateOutput(output)
    return {
      title,
      output: truncated.content,
      metadata: { status: res.status, contentType, truncated: truncated.truncated },
    }
  },
})
