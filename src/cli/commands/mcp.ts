import { getConfig, globalConfigFile, loadConfig, updateGlobalConfig } from "../../config/config"
import { mcpStatus, startMcp } from "../../mcp"
import type { McpServerConfig } from "../../mcp/client"
import { parse, UsageError, type CommandSpec } from "../args"
import { bootstrap } from "../bootstrap"
import fs from "node:fs/promises"
import { parse as parseJsonc } from "jsonc-parser"
import { redact } from "../../util/redact"

export const spec: CommandSpec = {
  usage: "vedecaps mcp <list|add|remove> [name] [-- command args..]",
  description: "manage MCP (Model Context Protocol) servers",
  options: {
    url: { type: "string", arg: "url", description: "add a remote server at this URL" },
    header: { type: "string", multiple: true, arg: "Name: value", description: "HTTP header for a remote server (repeatable)" },
    env: { type: "string", multiple: true, arg: "KEY=value", description: "environment variable for a local server (repeatable)" },
    help: { type: "boolean", short: "h", description: "show this help" },
  },
  examples: [
    "vedecaps mcp list",
    "vedecaps mcp add files -- npx -y @modelcontextprotocol/server-filesystem .",
    "vedecaps mcp add docs --url https://example.com/mcp --header 'Authorization: Bearer TOKEN'",
    "vedecaps mcp remove files",
  ],
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, spec.options!)
  await bootstrap()
  const [action, name, ...command] = positionals
  if (action === "list" || action === "ls") {
    const config = await getConfig()
    const names = Object.keys(config.mcp ?? {})
    if (names.length === 0) {
      process.stdout.write("No MCP servers configured. Add one with `vedecaps mcp add`.\n")
      return 0
    }
    await startMcp()
    const status = new Map(mcpStatus().map((s) => [s.name, s]))
    for (const n of names) {
      const s = status.get(n)
      const server = config.mcp![n]!
      const where = server.type === "remote" ? server.url : server.command.join(" ")
      process.stdout.write(redact(`${n.padEnd(16)} ${(s?.status ?? "unknown").padEnd(10)} ${s ? `${s.tools} tools`.padEnd(10) : "".padEnd(10)} ${where}${s?.error ? `\n    ${s.error.split("\n")[0]}` : ""}\n`))
    }
    return 0
  }
  if (action === "add") {
    if (!name || !/^[\w-]+$/.test(name)) throw new UsageError("Usage: vedecaps mcp add <name> (--url <url> | -- <command> [args..])")
    let server: McpServerConfig
    if (values.url) {
      const headers: Record<string, string> = {}
      for (const h of (values.header as string[] | undefined) ?? []) {
        const i = h.indexOf(":")
        if (i < 1) throw new UsageError(`Header must look like "Name: value" (got "${h}")`)
        headers[h.slice(0, i).trim()] = h.slice(i + 1).trim()
      }
      server = { type: "remote", url: values.url, ...(Object.keys(headers).length ? { headers } : {}) }
    } else {
      if (command.length === 0) throw new UsageError("Give a command after `--`, or use --url for a remote server.")
      const environment: Record<string, string> = {}
      for (const e of (values.env as string[] | undefined) ?? []) {
        const i = e.indexOf("=")
        if (i < 1) throw new UsageError(`--env must look like KEY=value (got "${e}")`)
        environment[e.slice(0, i)] = e.slice(i + 1)
      }
      server = { type: "local", command, ...(Object.keys(environment).length ? { environment } : {}) }
    }
    await updateGlobalConfig({ mcp: { [name]: server } })
    process.stdout.write(`Added MCP server "${name}" to ${globalConfigFile()}\n`)
    return 0
  }
  if (action === "remove" || action === "rm") {
    if (!name) throw new UsageError("Usage: vedecaps mcp remove <name>")
    const file = globalConfigFile()
    const text = await fs.readFile(file, "utf8").catch(() => "")
    const data = text ? (parseJsonc(text) as Record<string, any>) : {}
    if (!data?.mcp?.[name]) {
      process.stderr.write(`"${name}" is not defined in ${file}. (Servers from project config must be removed there.)\n`)
      return 1
    }
    delete data.mcp[name]
    await fs.writeFile(file, JSON.stringify(data, null, 2) + "\n")
    process.stdout.write(`Removed "${name}".\n`)
    return 0
  }
  void loadConfig
  throw new UsageError(`Unknown mcp action "${action ?? ""}". Use list, add or remove.`)
}
