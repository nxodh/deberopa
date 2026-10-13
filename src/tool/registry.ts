import type { AgentInfo } from "../agent/agent"
import { isDisabled } from "../permission/permission"
import { mcpTools } from "../mcp"
import { BashTool } from "./bash"
import { EditTool, MultiEditTool, WriteTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { ListTool } from "./list"
import { ReadTool } from "./read"
import { createSkillTool } from "./skill"
import { createTaskTool } from "./task"
import { TodoReadTool, TodoWriteTool } from "./todo"
import { WebFetchTool } from "./webfetch"
import type { ToolDefinition } from "./tool"

/** Tools that change files share the single "edit" permission. */
const PERMISSION_KEY: Record<string, string> = { write: "edit", multiedit: "edit", edit: "edit" }

export function permissionKey(toolID: string): string {
  return PERMISSION_KEY[toolID] ?? toolID
}

export const BUILTIN_TOOLS: ToolDefinition[] = [
  BashTool,
  ReadTool,
  EditTool,
  MultiEditTool,
  WriteTool,
  GlobTool,
  GrepTool,
  ListTool,
  WebFetchTool,
  TodoWriteTool,
  TodoReadTool,
]

/** Every tool id that can exist right now (for config UIs and docs). */
export async function allToolIDs(): Promise<string[]> {
  return [...BUILTIN_TOOLS.map((t) => t.id), "task", "skill", ...mcpTools().map((t) => t.id)]
}

/**
 * The toolbox for one agent. Order is deterministic (built-ins, then task/skill, then MCP
 * sorted by name) because the tool list is part of the cached prompt prefix.
 */
export async function toolsFor(agent: AgentInfo): Promise<ToolDefinition[]> {
  const tools: ToolDefinition[] = [...BUILTIN_TOOLS]
  const task = await createTaskTool(agent.name)
  if (task) tools.push(task)
  const skill = await createSkillTool()
  if (skill) tools.push(skill)
  tools.push(...mcpTools().sort((a, b) => a.id.localeCompare(b.id)))

  return tools.filter((tool) => {
    if (agent.tools[tool.id] === false) return false
    // "server_*": false style switches for whole MCP servers
    for (const [pattern, on] of Object.entries(agent.tools)) {
      if (on === false && pattern.endsWith("*") && tool.id.startsWith(pattern.slice(0, -1))) return false
    }
    return !isDisabled(agent.permission, permissionKey(tool.id))
  })
}
