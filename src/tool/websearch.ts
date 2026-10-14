import { getConfig } from "../config/config"
import { connectMcp, type McpClient } from "../mcp/client"
import { registerSecret } from "../util/redact"
import { defineTool, truncateOutput, ToolInputError } from "./tool"

/** Exa's hosted MCP server. Works without a key within a shared free limit. */
const DEFAULT_URL = "https://mcp.exa.ai/mcp"
const TOOL = "web_search_exa"

let cached: { url: string; client: Promise<McpClient> } | undefined

async function endpoint(): Promise<string> {
  const base = process.env.DEBEROPA_EXA_URL || DEFAULT_URL
  const config = await getConfig()
  const key = config.websearch?.apiKey || process.env.EXA_API_KEY
  if (!key) return base
  registerSecret(key)
  return `${base}${base.includes("?") ? "&" : "?"}exaApiKey=${encodeURIComponent(key)}`
}

async function client(): Promise<McpClient> {
  const url = await endpoint()
  if (cached?.url !== url) cached = { url, client: connectMcp("exa", { type: "remote", url, timeout: 45_000 }) }
  try {
    return await cached.client
  } catch (err) {
    cached = undefined
    throw err
  }
}

export function resetWebSearch() {
  const old = cached
  cached = undefined
  void old?.client.then((c) => c.close()).catch(() => {})
}

export const WebSearchTool = defineTool<{ query: string; numResults?: number; objective?: string }>({
  id: "websearch",
  description: `Searches the web (through Exa) and returns the most relevant pages with their content.

Use it for information that is recent or outside the codebase: library documentation, error messages, release notes, current versions. Do not use it for questions the repository itself can answer.

- Write the query as a natural-language description of the ideal page, not a bag of keywords.
- Say in "objective" what you need to find out; results are ranked for that goal.
- Follow up with webfetch on a promising URL when the returned excerpt is not enough.
- The query leaves this machine and is sent to Exa.`,
  parameters: {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string", description: "Natural-language search query describing the ideal page" },
      objective: { type: "string", description: "What you need to find out, and which results should rank first (defaults to the query)" },
      numResults: { type: "number", description: "Number of results to return (default 8, at most 20)" },
    },
  },
  async execute(args, ctx) {
    const query = args.query?.trim()
    if (!query) throw new ToolInputError("query must not be empty")
    await ctx.ask({
      permission: "websearch",
      patterns: ["exa"],
      always: ["exa"],
      title: `Search the web: ${query.slice(0, 120)}`,
      metadata: { query, provider: "exa" },
    })

    const numResults = Math.min(Math.max(Math.floor(args.numResults ?? 8), 1), 20)
    let text: string
    try {
      const result = await (await client()).callTool(TOOL, { query, numResults, objective: (args.objective ?? query).slice(0, 4000) }, { signal: ctx.abort })
      text = (result.content ?? []).map((c) => (c.type === "text" && typeof c.text === "string" ? c.text : "")).filter(Boolean).join("\n\n").trim()
      if (result.isError) throw new Error(text || "The search service reported an error.")
    } catch (err) {
      if (err instanceof Error && /aborted|abort/i.test(err.name + err.message)) throw err
      // A broken connection is dropped so the next search starts a fresh one.
      resetWebSearch()
      throw err
    }

    // The free tier reports its limit as ordinary content, not as an error.
    if (/rate limit/i.test(text) && text.length < 800) {
      throw new Error(
        "Exa's free search limit has been reached. Create a key at https://dashboard.exa.ai/api-keys and set EXA_API_KEY (or websearch.apiKey in deberopa.json) to continue.",
      )
    }
    if (text === "") return { title: query, output: "No results found.", metadata: { query, results: 0 } }
    const out = truncateOutput(text, { maxBytes: 40 * 1024 })
    return { title: query, output: out.content, metadata: { query, truncated: out.truncated } }
  },
})
