import { getConfig } from "../config/config"
import { createLogger } from "../util/log"
import { publish } from "../util/bus"
import { connectMcp, type McpClient, type McpTool } from "./client"
import { defineTool, type ToolDefinition } from "../tool/tool"

const log = createLogger("mcp")

export interface McpStatus {
  name: string
  status: "connecting" | "connected" | "failed" | "disabled"
  error?: string
  tools: number
}

interface Entry {
  status: McpStatus
  client?: McpClient
  tools: McpTool[]
}

const entries = new Map<string, Entry>()
let started: Promise<void> | undefined

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_")

/** Connect to every configured server. Safe to call repeatedly; failures are recorded, not thrown. */
export function startMcp(): Promise<void> {
  return (started ??= (async () => {
    const config = await getConfig()
    await Promise.all(
      Object.entries(config.mcp ?? {}).map(async ([name, server]) => {
        if (server.enabled === false) {
          entries.set(name, { status: { name, status: "disabled", tools: 0 }, tools: [] })
          return
        }
        const entry: Entry = { status: { name, status: "connecting", tools: 0 }, tools: [] }
        entries.set(name, entry)
        try {
          const client = await connectMcp(name, server)
          entry.client = client
          entry.tools = await client.listTools()
          entry.status = { name, status: "connected", tools: entry.tools.length }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          log.error(`failed to connect to ${name}`, message)
          entry.status = { name, status: "failed", error: message, tools: 0 }
        }
        publish("mcp.updated", { name })
      }),
    )
  })())
}

export function mcpStatus(): McpStatus[] {
  return [...entries.values()].map((e) => e.status)
}

/** MCP tools exposed to the model as `<server>_<tool>`. */
export function mcpTools(): ToolDefinition[] {
  const tools: ToolDefinition[] = []
  for (const [server, entry] of entries) {
    const client = entry.client
    if (!client) continue
    for (const tool of entry.tools) {
      const id = `${sanitize(server)}_${sanitize(tool.name)}`
      const schema = tool.inputSchema && typeof tool.inputSchema === "object" ? { ...tool.inputSchema } : {}
      if (schema.type !== "object") schema.type = "object"
      if (!schema.properties) schema.properties = {}
      tools.push(
        defineTool({
          id,
          description: tool.description || `${tool.name} (from the ${server} MCP server)`,
          parameters: schema,
          async execute(args, ctx) {
            await ctx.ask({ permission: id, patterns: ["*"], always: ["*"], title: `${server}: ${tool.name}`, metadata: { server, tool: tool.name, args } })
            const result = await client.callTool(tool.name, args ?? {}, { signal: ctx.abort })
            const text: string[] = []
            const attachments: { mime: string; data: string }[] = []
            for (const item of result.content ?? []) {
              if (item.type === "text" && typeof item.text === "string") text.push(item.text)
              else if (item.type === "image" && typeof item.data === "string") attachments.push({ mime: item.mimeType || "image/png", data: item.data })
              else if (item.type === "resource" && typeof (item as any).resource?.text === "string") text.push((item as any).resource.text)
            }
            const output = text.join("\n\n") || (attachments.length ? "(image output)" : "(no output)")
            if (result.isError) throw new Error(output)
            return { title: `${server}: ${tool.name}`, output, metadata: { server, tool: tool.name }, attachments }
          },
        }),
      )
    }
  }
  return tools
}

export async function shutdownMcp() {
  await Promise.all([...entries.values()].map((e) => e.client?.close().catch(() => {})))
  entries.clear()
  started = undefined
}
