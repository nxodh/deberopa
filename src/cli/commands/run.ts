import fs from "node:fs/promises"
import path from "node:path"
import { subscribe } from "../../util/bus"
import { getSession, listSessions, createSession } from "../../session/store"
import { prompt } from "../../session/prompt"
import { replyPermission } from "../../permission/permission"
import { getCommand, runCommand } from "../../command/command"
import { parseModelRef } from "../../provider/provider"
import { describeTool } from "../../tool/describe"
import { messageText, type AssistantMessage, type Part, type ToolPart } from "../../session/message"
import { parse, type CommandSpec, UsageError } from "../args"
import { readStdin } from "../input"
import { bootstrap } from "../bootstrap"

export const spec: CommandSpec = {
  usage: "vedecaps run [message..] [options]",
  description: "run a prompt non-interactively and print the answer",
  options: {
    continue: { type: "boolean", short: "c", description: "continue the most recent session" },
    session: { type: "string", short: "s", arg: "id", description: "continue a specific session" },
    model: { type: "string", short: "m", arg: "provider/model", description: "model to use" },
    agent: { type: "string", arg: "name", description: "agent to use (default: build)" },
    file: { type: "string", short: "f", multiple: true, arg: "path", description: "attach a file (repeatable)" },
    format: { type: "string", arg: "default|json", description: "output format: default (text) or json (event stream)" },
    command: { type: "string", arg: "name", description: "run a custom command, with the message as its arguments" },
    title: { type: "string", arg: "title", description: "title for a new session" },
    dir: { type: "string", arg: "path", description: "directory to work in" },
    "dangerously-skip-permissions": { type: "boolean", description: "approve every permission request automatically" },
    "print-logs": { type: "boolean", description: "print the log to stderr" },
    help: { type: "boolean", short: "h", description: "show this help" },
  },
  examples: [
    'vedecaps run "explain what this repo does"',
    'git diff | vedecaps run "write a commit message for this"',
    'vedecaps run -m anthropic/claude-sonnet-5-5 --agent plan "plan a refactor of src/auth"',
    "vedecaps run --format json \"list the TODOs\" > events.jsonl",
  ],
}

const IMAGE_OR_PDF = /^(image\/(png|jpe?g|gif|webp)|application\/pdf)$/

function mimeOf(file: string): string {
  const ext = path.extname(file).toLowerCase()
  return (
    { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf" }[ext] ??
    "text/plain"
  )
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, spec.options!)
  if (values.format && !["default", "json"].includes(values.format)) throw new UsageError(`--format must be "default" or "json"`)
  const json = values.format === "json"
  await bootstrap({ directory: values.dir ? path.resolve(values.dir) : undefined, printLogs: values["print-logs"], mcp: true })

  let message = positionals.join(" ").trim()
  const piped = (await readStdin({ firstByteTimeoutMs: message ? 400 : 3000 })).trim()
  if (piped) message = message ? `${message}\n\n${piped}` : piped
  if (!message && !values.command) throw new UsageError("No message given. Pass it as arguments or pipe it in: vedecaps run \"your request\"")

  const files: { mime: string; filename?: string; data: string }[] = []
  for (const file of (values.file as string[] | undefined) ?? []) {
    const abs = path.resolve(file)
    const stat = await fs.stat(abs).catch(() => undefined)
    if (!stat?.isFile()) throw new UsageError(`File not found: ${file}`)
    const mime = mimeOf(abs)
    if (IMAGE_OR_PDF.test(mime)) files.push({ mime, filename: path.basename(abs), data: (await fs.readFile(abs)).toString("base64") })
    else message += `\n\n@${abs}`
  }

  let sessionID: string
  if (values.session) {
    const found = await getSession(values.session)
    if (!found) throw new UsageError(`Session not found: ${values.session}`)
    sessionID = found.id
  } else if (values.continue) {
    const latest = (await listSessions())[0]
    sessionID = latest ? latest.id : (await createSession({ title: values.title })).id
  } else {
    sessionID = (await createSession({ title: values.title })).id
  }

  // Slash commands work here too: `vedecaps run "/review main"`.
  let commandName: string | undefined = values.command
  let commandArgs = message
  const slash = /^\/([\w./-]+)(?:\s+([\s\S]*))?$/.exec(message)
  if (!commandName && slash && (await getCommand(slash[1]!))) {
    commandName = slash[1]
    commandArgs = slash[2] ?? ""
  }

  const skip = !!values["dangerously-skip-permissions"]
  let denied = 0
  const stderr = (line: string) => process.stderr.write(line + "\n")
  const emitted = new Set<string>()
  const emit = (type: string, extra: Record<string, unknown>) => {
    process.stdout.write(JSON.stringify({ type, timestamp: Date.now(), sessionID, ...extra }) + "\n")
  }

  const off: (() => void)[] = []
  off.push(
    subscribe("permission.asked", (event) => {
      const info = event.properties as { id: string; sessionID: string; permission: string; title: string }
      if (skip) return void replyPermission(info.id, "once")
      denied++
      stderr(`! permission denied (${info.permission}): ${info.title}`)
      stderr("  re-run with --dangerously-skip-permissions to allow, or configure `permission` in vedecaps.json")
      replyPermission(info.id, "reject")
    }),
  )

  let wroteText = false
  let lastChar = "\n"
  off.push(
    subscribe<{ sessionID: string; messageID: string; part: Part; delta?: string }>("message.part.updated", (event) => {
      const { part, delta } = event.properties
      const isRoot = event.properties.sessionID === sessionID
      if (part.type === "text" && delta && isRoot && !json) {
        process.stdout.write(delta)
        wroteText = true
        lastChar = delta.slice(-1)
      }
      if (part.type === "tool") {
        const state = part.state
        if (json) {
          if ((state.status === "completed" || state.status === "error") && !emitted.has(part.id)) {
            emitted.add(part.id)
            emit("tool", { part: { ...part, sessionID: event.properties.sessionID } })
          }
          return
        }
        if (state.status === "running" && !emitted.has(part.id)) {
          emitted.add(part.id)
          const { name, detail } = describeTool(part as ToolPart)
          stderr(`${isRoot ? "•" : "  ◦"} ${name} ${detail}`.trimEnd())
        } else if (state.status === "error" && !String(state.error).includes("interrupted")) {
          stderr(`  ✗ ${describeTool(part as ToolPart).name}: ${firstLine(state.error)}`)
        }
      }
    }),
  )
  if (json) {
    off.push(
      subscribe<{ message: AssistantMessage }>("message.updated", (event) => {
        const m = event.properties.message
        if (m.sessionID !== sessionID || m.role !== "assistant" || !m.time.completed) return
        for (const part of m.parts) {
          if ((part.type === "text" || part.type === "reasoning") && part.text.trim() && !emitted.has(part.id)) {
            emitted.add(part.id)
            emit(part.type, { part })
          }
        }
        emit("step_finish", { messageID: m.id, tokens: m.tokens, cost: m.cost, finish: m.finish, error: m.error })
      }),
    )
  }

  let result: AssistantMessage | undefined
  try {
    const model = values.model ? parseModelRef(values.model) : undefined
    if (model && !model.providerID) throw new UsageError(`--model must look like provider/model (got "${values.model}")`)
    result = commandName
      ? await runCommand({ sessionID, name: commandName, arguments: commandArgs, agent: values.agent, model })
      : await prompt({ sessionID, text: message, files, agent: values.agent, model })
  } finally {
    for (const fn of off) fn()
  }

  if (!json && wroteText && lastChar !== "\n") process.stdout.write("\n")
  if (!json && !wroteText && result) {
    // The model answered only with tool calls (or text arrived without deltas): print what there is.
    const text = messageText(result)
    if (text) process.stdout.write(text + "\n")
  }
  const error = result?.error
  if (error && error.name !== "Aborted") {
    if (json) emit("error", { error })
    else stderr(`Error: ${error.message}`)
    return 1
  }
  if (denied > 0) return 1
  return 0
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? ""
  return line.length > 160 ? line.slice(0, 159) + "…" : line
}
