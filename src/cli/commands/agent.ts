import fs from "node:fs/promises"
import path from "node:path"
import { listAgents } from "../../agent/agent"
import { Paths } from "../../global"
import { project } from "../../project"
import { exists } from "../../util/fs"
import { parse, UsageError, type CommandSpec } from "../args"
import { ask } from "../input"
import { bootstrap } from "../bootstrap"

export const spec: CommandSpec = {
  usage: "vedecaps agent <list|create> [options]",
  description: "list agents or scaffold a new one",
  options: {
    name: { type: "string", arg: "name", description: "agent name (create)" },
    description: { type: "string", arg: "text", description: "what the agent is for (create)" },
    mode: { type: "string", arg: "primary|subagent|all", description: "where it can be used (create; default: all)" },
    model: { type: "string", arg: "provider/model", description: "model override (create)" },
    prompt: { type: "string", arg: "text", description: "system prompt text (create)" },
    global: { type: "boolean", description: "create in your global config instead of this project" },
    help: { type: "boolean", short: "h", description: "show this help" },
  },
  examples: ["vedecaps agent list", 'vedecaps agent create --name reviewer --mode subagent --description "Reviews diffs"'],
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, spec.options!)
  await bootstrap()
  const action = positionals[0]
  if (action === "list" || action === "ls") {
    for (const agent of Object.values(await listAgents()).sort((a, b) => a.name.localeCompare(b.name))) {
      if (agent.hidden) continue
      process.stdout.write(`${agent.name.padEnd(14)} ${agent.mode.padEnd(9)} ${agent.builtIn ? "built-in" : "custom  "}  ${agent.description ?? ""}\n`)
    }
    return 0
  }
  if (action === "create") {
    const interactive = !!process.stdin.isTTY
    const name = (values.name ?? (interactive ? await ask("Agent name: ") : "")).trim()
    if (!/^[a-zA-Z0-9][\w-]*$/.test(name)) throw new UsageError("Agent name is required and may only contain letters, digits, - and _ (use --name).")
    const description = values.description ?? (interactive ? await ask("What is it for? ") : "")
    const mode = values.mode ?? "all"
    if (!["primary", "subagent", "all"].includes(mode)) throw new UsageError("--mode must be primary, subagent or all")
    const dir = values.global ? path.join(Paths.config, "agent") : path.join(project().worktree, ".vedecaps", "agent")
    const file = path.join(dir, `${name}.md`)
    if (await exists(file)) throw new UsageError(`${file} already exists.`)
    const front = [`description: ${JSON.stringify(description || `The ${name} agent`)}`, `mode: ${mode}`]
    if (values.model) front.push(`model: ${values.model}`)
    const body = values.prompt ?? `You are the ${name} agent. ${description}`.trim()
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(file, `---\n${front.join("\n")}\n---\n\n${body}\n`)
    process.stdout.write(`Created ${file}\nEdit it to refine the prompt, or add \`tools:\` and \`permission:\` to the frontmatter.\n`)
    return 0
  }
  throw new UsageError(`Unknown agent action "${action ?? ""}". Use list or create.`)
}
