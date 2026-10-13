import fs from "node:fs/promises"
import path from "node:path"
import { bootstrap } from "../bootstrap"
import { listSessions } from "../../session/store"
import { shareHTML, startShareViewer } from "../../session/share"
import { parse, type CommandSpec, UsageError } from "../args"

export const spec: CommandSpec = {
  usage: "vedecaps share [session-id] [options]",
  description: "export a read-only HTML conversation or serve it temporarily",
  options: {
    out: { type: "string", short: "o", arg: "file", description: "HTML file to review and share (default session.html)" },
    serve: { type: "boolean", description: "start an expiring read-only viewer after reviewing the HTML" },
    yes: { type: "boolean", short: "y", description: "confirm that you reviewed the conversation for private content" },
    hostname: { type: "string", arg: "host", description: "loopback bind address (default 127.0.0.1)" },
    port: { type: "string", arg: "port", description: "viewer port (default random)" },
    ttl: { type: "string", arg: "seconds", description: "link lifetime, 1..86400 (default 3600)" },
  },
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, spec.options!)
  await bootstrap()
  const id = positionals[0] ?? (await listSessions())[0]?.id
  if (!id) throw new UsageError("No session to share")
  const html = await shareHTML(id)
  const file = path.resolve(values.out ?? "session.html")
  await fs.writeFile(file, html, { mode: 0o600 })
  process.stdout.write(`Saved ${file}. Review private content before distributing it.\n`)
  if (!values.serve) return 0
  if (!values.yes) throw new UsageError("Review the HTML, then use --serve --yes to create a temporary link.")
  const port = Number(values.port ?? 0)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError("Invalid port")
  const viewer = startShareViewer(html, { port, hostname: values.hostname, ttl: Number(values.ttl ?? 3600) })
  process.stdout.write(`${viewer.url}\nAnyone with this link can read it. Ctrl+C stops sharing.\n`)
  const stop = () => viewer.close()
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  try { await viewer.closed } finally {
    process.off("SIGINT", stop)
    process.off("SIGTERM", stop)
    viewer.close()
  }
  return 0
}
