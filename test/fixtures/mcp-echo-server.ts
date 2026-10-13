// Minimal stdio MCP server for test/mcp.test.ts. Newline-delimited JSON-RPC on stdin/stdout.
import readline from "node:readline"

const echoTool = {
  name: "echo",
  description: "Returns the given text",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
}
const failTool = { name: "fail", description: "Always returns an error result", inputSchema: { type: "object", properties: {} } }
const greetPrompt = {
  name: "greet",
  description: "Greets someone by name",
  arguments: [{ name: "name", description: "Who to greet", required: true }],
}

function send(message: unknown) {
  process.stdout.write(JSON.stringify(message) + "\n")
}

function respond(id: number | string, result: unknown) {
  send({ jsonrpc: "2.0", id, result })
}

function reject(id: number | string, code: number, message: string) {
  send({ jsonrpc: "2.0", id, error: { code, message } })
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let req: { id?: number | string; method: string; params?: any }
  try {
    req = JSON.parse(line)
  } catch {
    return
  }
  // Notifications carry no id and need no reply.
  if (req.id === undefined) return
  const id = req.id
  const p: any = req.params ?? {}

  switch (req.method) {
    case "initialize":
      return respond(id, {
        protocolVersion: p.protocolVersion,
        capabilities: { tools: {}, prompts: {} },
        serverInfo: { name: "echo-fixture", version: "1.0.0" },
      })
    case "ping":
      return respond(id, {})
    case "tools/list":
      // Two pages, so pagination is exercised.
      return respond(id, p.cursor === "page-2" ? { tools: [failTool] } : { tools: [echoTool], nextCursor: "page-2" })
    case "tools/call":
      if (p.name === "echo") return respond(id, { content: [{ type: "text", text: String(p.arguments?.text) }] })
      if (p.name === "fail") return respond(id, { content: [{ type: "text", text: "failed on purpose" }], isError: true })
      return reject(id, -32602, `Unknown tool: ${p.name}`)
    case "prompts/list":
      return respond(id, { prompts: [greetPrompt] })
    case "prompts/get":
      if (p.name === "greet") {
        return respond(id, {
          messages: [{ role: "user", content: { type: "text", text: `Hello, ${p.arguments?.name}!` } }],
        })
      }
      return reject(id, -32602, `Unknown prompt: ${p.name}`)
    default:
      return reject(id, -32601, `Method not found: ${req.method}`)
  }
})
