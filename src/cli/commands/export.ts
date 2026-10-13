import fs from "node:fs/promises"
import path from "node:path"
import { exportJSON, exportMarkdown, importExport, parseExport, ImportError } from "../../session/export"
import { getSession, listSessions } from "../../session/store"
import { parse, UsageError, type CommandSpec } from "../args"
import { bootstrap } from "../bootstrap"

export const exportSpec: CommandSpec = {
  usage: "vedecaps export [session-id] [options]",
  description: "export a session as JSON or Markdown (default: the latest session)",
  options: {
    format: { type: "string", arg: "json|markdown", description: "output format (default: json)" },
    out: { type: "string", short: "o", arg: "file", description: "write to a file instead of stdout" },
    thinking: { type: "boolean", description: "include reasoning (markdown)" },
    help: { type: "boolean", short: "h", description: "show this help" },
  },
  examples: ["vedecaps export > session.json", "vedecaps export ses_0123 --format markdown -o notes.md"],
}

export async function exportMain(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, exportSpec.options!)
  await bootstrap()
  const format = values.format ?? "json"
  if (!["json", "markdown", "md"].includes(format)) throw new UsageError("--format must be json or markdown")
  let id = positionals[0]
  if (!id) {
    id = (await listSessions())[0]?.id
    if (!id) {
      process.stderr.write("No sessions to export.\n")
      return 1
    }
  } else if (!(await getSession(id))) {
    process.stderr.write(`Session not found: ${id}\n`)
    return 1
  }
  const text = format === "json" ? JSON.stringify(await exportJSON(id), null, 2) + "\n" : await exportMarkdown(id, { thinking: values.thinking })
  if (values.out) {
    await fs.writeFile(path.resolve(values.out), text)
    process.stderr.write(`Wrote ${values.out}\n`)
  } else process.stdout.write(text)
  return 0
}

export const importSpec: CommandSpec = {
  usage: "vedecaps import <file>",
  description: "import a session exported with `vedecaps export`",
  options: { help: { type: "boolean", short: "h", description: "show this help" } },
  examples: ["vedecaps import session.json"],
}

export async function importMain(argv: string[]): Promise<number> {
  const { positionals } = parse(argv, importSpec.options!)
  const file = positionals[0]
  if (!file) throw new UsageError("Usage: vedecaps import <file>")
  await bootstrap()
  let text: string
  try {
    text = await fs.readFile(path.resolve(file), "utf8")
  } catch {
    process.stderr.write(`Cannot read ${file}\n`)
    return 1
  }
  try {
    const info = await importExport(parseExport(text))
    process.stdout.write(`Imported as ${info.id}: ${info.title}\nResume it with \`vedecaps -s ${info.id}\`.\n`)
    return 0
  } catch (err) {
    if (err instanceof ImportError) {
      process.stderr.write(err.message + "\n")
      return 1
    }
    throw err
  }
}
