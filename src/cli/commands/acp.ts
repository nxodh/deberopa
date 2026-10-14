import path from "node:path"
import { parse, type CommandSpec } from "../args"
import { bootstrap } from "../bootstrap"
import { serveAcp } from "../../acp/server"

export const spec: CommandSpec = {
  usage: "deberopa acp [options]",
  description: "run as an Agent Client Protocol server on stdin/stdout (for Zed and other editors)",
  options: {
    cwd: { type: "string", arg: "path", description: "project directory (default: the current directory)" },
    "print-logs": { type: "boolean", description: "print the log to stderr" },
  },
  examples: [
    "deberopa acp",
    '# Zed settings.json: "agent_servers": { "Deberopa": { "command": "deberopa", "args": ["acp"] } }',
  ],
}

export async function main(argv: string[]): Promise<number> {
  const { values } = parse(argv, spec.options!)
  const directory = values.cwd ? path.resolve(values.cwd) : process.cwd()
  // stdout belongs to the protocol: logs go to the log file (or stderr with --print-logs), never stdout
  await bootstrap({ directory, printLogs: values["print-logs"], mcp: "background" })
  await serveAcp({ input: process.stdin, output: process.stdout, directory })
  return 0
}
