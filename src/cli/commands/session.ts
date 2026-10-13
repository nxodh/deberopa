import { deleteSession, getSession, listSessions } from "../../session/store"
import { parse, UsageError, type CommandSpec } from "../args"
import { bootstrap } from "../bootstrap"

export const spec: CommandSpec = {
  usage: "vedecaps session <list|delete> [id]",
  description: "list or delete saved sessions",
  options: {
    all: { type: "boolean", description: "include sessions from every project" },
    max: { type: "string", short: "n", arg: "count", description: "show at most this many (list)" },
    format: { type: "string", arg: "table|json", description: "output format (list)" },
    help: { type: "boolean", short: "h", description: "show this help" },
  },
  examples: ["vedecaps session list", "vedecaps session list --all -n 20", "vedecaps session delete ses_0123abcd"],
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, spec.options!)
  await bootstrap()
  const [action, id] = positionals
  if (action === "list" || action === "ls") {
    const max = values.max ? Number(values.max) : undefined
    if (max !== undefined && (!Number.isInteger(max) || max < 1)) throw new UsageError("--max must be a positive integer")
    let sessions = await listSessions({ all: values.all })
    if (max) sessions = sessions.slice(0, max)
    if (values.format === "json") {
      process.stdout.write(JSON.stringify(sessions, null, 2) + "\n")
      return 0
    }
    if (sessions.length === 0) process.stdout.write("No sessions yet.\n")
    for (const s of sessions) process.stdout.write(`${s.id}  ${ago(s.time.updated).padEnd(9)} ${s.title}\n`)
    return 0
  }
  if (action === "delete" || action === "rm") {
    if (!id) throw new UsageError("Usage: vedecaps session delete <id>")
    if (!(await getSession(id))) {
      process.stderr.write(`Session not found: ${id}\n`)
      return 1
    }
    await deleteSession(id)
    process.stdout.write(`Deleted ${id}\n`)
    return 0
  }
  throw new UsageError(`Unknown session action "${action ?? ""}". Use list or delete.`)
}
