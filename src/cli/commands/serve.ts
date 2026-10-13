import path from "node:path"
import { parse, UsageError, type CommandSpec } from "../args"
import { bootstrap } from "../bootstrap"
import { getConfig } from "../../config/config"
import { startServer } from "../../server/server"

export const spec: CommandSpec = {
  usage: "vedecaps serve [options]",
  description: "start the HTTP API server (no terminal UI)",
  options: {
    port: { type: "string", arg: "number", description: "port to listen on (default 4096; 0 picks a free port)" },
    hostname: { type: "string", arg: "host", description: "interface to bind (default 127.0.0.1)" },
    dir: { type: "string", arg: "path", description: "project directory to serve" },
    "print-logs": { type: "boolean", description: "print the log to stderr" },
  },
  examples: [
    "vedecaps serve",
    "VEDECAPS_SERVER_PASSWORD=change-me vedecaps serve --hostname 0.0.0.0 --port 8080",
    "curl -N http://127.0.0.1:4096/event",
  ],
}

export async function main(argv: string[]): Promise<number> {
  const { values } = parse(argv, spec.options!)
  await bootstrap({ directory: values.dir ? path.resolve(values.dir) : undefined, printLogs: values["print-logs"], mcp: "background" })
  const config = await getConfig()
  const port = values.port !== undefined ? Number(values.port) : (config.server?.port ?? 4096)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError("--port must be a number between 0 and 65535")
  const hostname = values.hostname ?? config.server?.hostname ?? "127.0.0.1"
  const local = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1"
  if (!local && !process.env.VEDECAPS_SERVER_PASSWORD) {
    process.stderr.write(
      "Warning: listening on a non-local interface without VEDECAPS_SERVER_PASSWORD. Anyone who can reach this port can run commands on this machine.\n",
    )
  }
  const server = startServer({ port, hostname })
  process.stdout.write(`vedecaps server listening on http://${server.hostname}:${server.port}\n`)
  // Serve until interrupted; runAndExit's signal handler shuts everything down.
  await new Promise<void>(() => {})
  return 0
}
