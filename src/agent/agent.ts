import fs from "node:fs/promises"
import path from "node:path"
import { loadConfig, type AgentConfig } from "../config/config"
import { parseModelRef } from "../provider/provider"
import { DEFAULT_RULES, mergeRulesets, toRuleset, type Ruleset } from "../permission/permission"
import { parseFrontmatter } from "../util/frontmatter"
import type { Effort } from "../provider/types"

export interface AgentInfo {
  name: string
  description?: string
  /** primary agents are selectable in the UI; subagents are invoked through the task tool. */
  mode: "primary" | "subagent" | "all"
  builtIn: boolean
  hidden?: boolean
  prompt?: string
  model?: { providerID: string; modelID: string }
  temperature?: number
  topP?: number
  steps?: number
  effort?: Effort
  /** Explicit tool switches; anything not listed is on. */
  tools: Record<string, boolean>
  permission: Ruleset
}

const READ_ONLY_BASH: Record<string, "allow" | "ask"> = {
  "*": "ask",
  "ls *": "allow",
  "cat *": "allow",
  "head *": "allow",
  "tail *": "allow",
  "wc *": "allow",
  "pwd": "allow",
  "which *": "allow",
  "find *": "allow",
  "grep *": "allow",
  "rg *": "allow",
  "tree *": "allow",
  "git status *": "allow",
  "git diff *": "allow",
  "git log *": "allow",
  "git show *": "allow",
  "git branch": "allow",
  "git branch -v": "allow",
  "Get-ChildItem *": "allow",
  "Get-Content *": "allow",
  "Select-String *": "allow",
  "find * -delete *": "ask",
  "find * -exec *": "ask",
}

const EXPLORE_PROMPT = `You are a file search specialist. You excel at thoroughly navigating and exploring codebases.

Your strengths:
- Rapidly finding files using glob patterns
- Searching code and text with powerful regex patterns
- Reading and analyzing file contents

Guidelines:
- Use glob for broad file pattern matching, grep for searching file contents, and read when you know the specific file path.
- Use bash only for read-only operations (listing, git log, git diff). Never create, modify or delete files.
- Adapt your search depth to the thoroughness level requested by the caller.
- Return file paths as absolute paths in your final response, and quote the relevant lines so the caller does not have to re-read them.
- Your final message is the only thing the caller sees: make it a complete, self-contained report of what you found.`

const GENERAL_PROMPT = `You are a general-purpose agent working on a delegated task. Complete exactly what was asked, using the tools available.

Your final message is the only thing the caller sees: report what you did, what you found, the absolute paths of any files involved, and anything that did not work. Do not ask follow-up questions; make reasonable assumptions and state them.`

function builtIns(): Record<string, AgentInfo> {
  return {
    build: {
      name: "build",
      description: "The default agent. Full access to tools for building and changing code.",
      mode: "primary",
      builtIn: true,
      tools: {},
      permission: {},
    },
    plan: {
      name: "plan",
      description: "Plan mode. Reads and analyses, but does not change files.",
      mode: "primary",
      builtIn: true,
      tools: {},
      permission: { edit: { "*": "deny" }, bash: READ_ONLY_BASH },
    },
    general: {
      name: "general",
      description:
        "General-purpose agent for researching complex questions and executing multi-step tasks. Use it to run several units of work in parallel.",
      mode: "subagent",
      builtIn: true,
      prompt: GENERAL_PROMPT,
      tools: { todowrite: false, todoread: false, task: false },
      permission: {},
    },
    explore: {
      name: "explore",
      description:
        'Fast, read-only agent specialised in exploring codebases. Use it to find files by pattern, search code for keywords, or answer questions about how the codebase works. Specify the thoroughness you want: "quick", "medium" or "very thorough".',
      mode: "subagent",
      builtIn: true,
      prompt: EXPLORE_PROMPT,
      tools: { todowrite: false, todoread: false, task: false, write: false, edit: false, multiedit: false, patch: false },
      permission: { edit: { "*": "deny" }, bash: READ_ONLY_BASH },
    },
  }
}

function applyConfig(base: AgentInfo | undefined, name: string, cfg: AgentConfig, body?: string): AgentInfo | undefined {
  if (cfg.disable) return undefined
  const agent: AgentInfo = base
    ? { ...base, tools: { ...base.tools }, permission: { ...base.permission } }
    : { name, mode: "all", builtIn: false, tools: {}, permission: {} }
  if (cfg.description) agent.description = cfg.description
  if (cfg.mode) agent.mode = cfg.mode
  if (cfg.hidden !== undefined) agent.hidden = cfg.hidden
  if (cfg.model) {
    const ref = parseModelRef(String(cfg.model))
    if (ref.providerID) agent.model = ref
  }
  const prompt = body && body.trim() !== "" ? body : cfg.prompt
  if (prompt) agent.prompt = prompt
  if (typeof cfg.temperature === "number") agent.temperature = cfg.temperature
  if (typeof cfg.top_p === "number") agent.topP = cfg.top_p
  if (typeof cfg.steps === "number") agent.steps = cfg.steps
  if (cfg.reasoning_effort) agent.effort = cfg.reasoning_effort as Effort
  if (cfg.tools && typeof cfg.tools === "object") agent.tools = { ...agent.tools, ...cfg.tools }
  if (cfg.permission) agent.permission = mergeRulesets(agent.permission, toRuleset(cfg.permission))
  return agent
}

let cached: Promise<Record<string, AgentInfo>> | undefined

export function resetAgents() {
  cached = undefined
}

export function listAgents(): Promise<Record<string, AgentInfo>> {
  return (cached ??= load())
}

async function load(): Promise<Record<string, AgentInfo>> {
  const { config, directories } = await loadConfig()
  const agents: Record<string, AgentInfo | undefined> = builtIns()

  // Markdown agents: <config dir>/agent/*.md (also "agents/"), file name is the agent name.
  for (const dir of directories) {
    for (const sub of ["agent", "agents"]) {
      const folder = path.join(dir, sub)
      const files = await fs.readdir(folder).catch(() => [] as string[])
      for (const file of files.filter((f) => f.endsWith(".md")).sort()) {
        const name = path.basename(file, ".md")
        try {
          const { data, content } = parseFrontmatter(await fs.readFile(path.join(folder, file), "utf8"))
          agents[name] = applyConfig(agents[name], name, data as AgentConfig, content)
        } catch {
          // an unreadable agent file should not break every other agent
        }
      }
    }
  }
  for (const [name, cfg] of Object.entries(config.agent ?? {})) {
    agents[name] = applyConfig(agents[name], name, cfg)
  }

  const globalRules = mergeRulesets(DEFAULT_RULES, toRuleset(config.permission))
  const result: Record<string, AgentInfo> = {}
  for (const [name, agent] of Object.entries(agents)) {
    if (!agent) continue
    result[name] = {
      ...agent,
      tools: { ...config.tools, ...agent.tools },
      permission: mergeRulesets(globalRules, agent.permission),
    }
  }
  return result
}

export async function getAgent(name: string): Promise<AgentInfo | undefined> {
  return (await listAgents())[name]
}

export async function primaryAgents(): Promise<AgentInfo[]> {
  return Object.values(await listAgents()).filter((a) => a.mode !== "subagent" && !a.hidden)
}

export async function subAgents(): Promise<AgentInfo[]> {
  return Object.values(await listAgents()).filter((a) => a.mode !== "primary" && !a.hidden)
}

export async function defaultAgentName(): Promise<string> {
  const { config } = await loadConfig()
  const agents = await listAgents()
  if (config.default_agent && agents[config.default_agent] && agents[config.default_agent]!.mode !== "subagent") return config.default_agent
  return agents.build ? "build" : ((await primaryAgents())[0]?.name ?? "build")
}
