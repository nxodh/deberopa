import fs from "node:fs/promises"
import path from "node:path"
import { loadConfig } from "../config/config"
import { project } from "../project"
import { parseModelRef } from "../provider/provider"
import { parseFrontmatter } from "../util/frontmatter"
import { BashTool } from "../tool/bash"
import { askPermission } from "../permission/permission"
import { resolveTarget } from "../session/prompt"
import { Paths } from "../global"
import { toPosix } from "../util/fs"
import { prompt, type PromptInput } from "../session/prompt"
import { INIT_TEMPLATE, REVIEW_TEMPLATE } from "./builtin"

export interface CommandInfo {
  name: string
  description?: string
  agent?: string
  model?: { providerID: string; modelID: string }
  /** Run through a subagent instead of the current conversation. */
  subtask?: boolean
  template: string
  source: "builtin" | "file" | "config"
}

let cached: Promise<Record<string, CommandInfo>> | undefined

export function resetCommands() {
  cached = undefined
}

export function listCommands(): Promise<Record<string, CommandInfo>> {
  return (cached ??= load())
}

export async function getCommand(name: string): Promise<CommandInfo | undefined> {
  return (await listCommands())[name]
}

async function markdownFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await markdownFiles(full)))
    else if (entry.name.endsWith(".md")) out.push(full)
  }
  return out
}

async function load(): Promise<Record<string, CommandInfo>> {
  const { config, directories, trusted } = await loadConfig()
  const commands: Record<string, CommandInfo> = {
    init: {
      name: "init",
      description: "create or improve AGENTS.md for this project",
      template: INIT_TEMPLATE,
      source: "builtin",
    },
    review: {
      name: "review",
      description: "review changes: uncommitted, a commit, a branch or a PR",
      template: REVIEW_TEMPLATE,
      subtask: false,
      source: "builtin",
    },
  }

  for (const dir of directories) {
    if (!trusted && dir !== Paths.config) continue
    for (const sub of ["command", "commands"]) {
      const folder = path.join(dir, sub)
      for (const file of await markdownFiles(folder)) {
        const name = toPosix(path.relative(folder, file)).replace(/\.md$/, "")
        try {
          const { data, content } = parseFrontmatter(await fs.readFile(file, "utf8"))
          commands[name] = {
            name,
            description: typeof data.description === "string" ? data.description : undefined,
            agent: typeof data.agent === "string" ? data.agent : undefined,
            model: typeof data.model === "string" && data.model.includes("/") ? parseModelRef(data.model) : undefined,
            subtask: data.subtask === true,
            template: content,
            source: "file",
          }
        } catch {
          // one broken command file must not hide the others
        }
      }
    }
  }

  for (const [name, entry] of Object.entries(config.command ?? {})) {
    if (!entry || typeof entry.template !== "string") continue
    commands[name] = {
      name,
      description: entry.description,
      agent: entry.agent,
      model: entry.model?.includes("/") ? parseModelRef(entry.model) : undefined,
      subtask: entry.subtask,
      template: entry.template,
      source: "config",
    }
  }
  return commands
}

/** Split on whitespace, keeping "quoted phrases" together. */
export function splitArguments(raw: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (const m of raw.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3] ?? "")
  return out
}

const MAX_INJECTED = 30_000

async function injectShell(template: string, execute?: (command: string) => Promise<string>): Promise<string> {
  const re = /!`([^`]+)`/g
  const matches = [...template.matchAll(re)]
  if (matches.length === 0) return template
  if (!execute) throw new Error("Shell substitutions require a session and its permission checks.")
  const outputs = await Promise.all(
    matches.map(async (m) => {
      const text = (await execute(m[1]!)).trim()
      return text.length > MAX_INJECTED ? text.slice(0, MAX_INJECTED) + "\n... (output truncated)" : text
    }),
  )
  let i = 0
  return template.replace(re, () => outputs[i++] ?? "")
}

/** Fill in `$ARGUMENTS`, `$1`..`$9` and `` !`cmd` `` output. `@file` mentions are resolved later by the prompt. */
export async function expandTemplate(template: string, rawArguments: string, cwd = project().directory, execute?: (command: string) => Promise<string>): Promise<string> {
  const args = splitArguments(rawArguments)
  const usesPlaceholder = /\$ARGUMENTS|\$[1-9]/.test(template)
  // Shell syntax introduced by arguments is data, never another executable substitution.
  let text = (await injectShell(template, execute)).replace(/\$ARGUMENTS/g, () => rawArguments.trim())
  // The last positional placeholder swallows the remaining arguments, so `/cmd a b c` with only $1 $2 keeps "b c" together.
  const highest = Math.max(0, ...[...template.matchAll(/\$([1-9])/g)].map((m) => Number(m[1])))
  text = text.replace(/\$([1-9])/g, (_, d: string) => {
    const n = Number(d)
    if (n === highest) return args.slice(n - 1).join(" ")
    return args[n - 1] ?? ""
  })
  if (!usesPlaceholder && rawArguments.trim()) text += `\n\n${rawArguments.trim()}`
  return text.trim()
}

export interface RunCommandInput {
  sessionID: string
  name: string
  arguments?: string
  agent?: string
  model?: { providerID: string; modelID: string }
}

export class CommandNotFoundError extends Error {
  constructor(name: string) {
    super(`Unknown command: /${name}`)
    this.name = "CommandNotFoundError"
  }
}

/** Expand and send a custom command as a normal prompt. */
export async function runCommand(input: RunCommandInput) {
  const command = await getCommand(input.name)
  if (!command) throw new CommandNotFoundError(input.name)
  const text = await expandTemplate(command.template, input.arguments ?? "", project().directory, async (script) => {
    const { agent } = await resolveTarget(input.sessionID, { agent: command.agent ?? input.agent, model: command.model ?? input.model })
    const result = await BashTool.execute({ command: script, timeout: 30_000 }, {
      sessionID: input.sessionID, messageID: "", callID: "", agent: agent.name,
      abort: AbortSignal.timeout(35_000), directory: project().directory, worktree: project().worktree,
      metadata: () => {}, ask: (request) => askPermission({ ...request, sessionID: input.sessionID, ruleset: agent.permission }),
    })
    return result.output
  })
  const request: PromptInput = {
    sessionID: input.sessionID,
    text,
    agent: command.subtask ? input.agent : (command.agent ?? input.agent),
    model: command.model ?? input.model,
  }
  if (command.subtask && command.agent) {
    request.synthetic = [
      `Delegate this request to the "${command.agent}" subagent by calling the task tool with subagent_type "${command.agent}" and a prompt that contains everything it needs. Relay its result to the user.`,
    ]
  }
  return prompt(request)
}
