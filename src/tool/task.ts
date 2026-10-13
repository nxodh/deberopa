import { defineTool, ToolInputError, type ToolDefinition } from "./tool"
import { subAgents } from "../agent/agent"
import { subscribe } from "../util/bus"
import type { ToolPart } from "../session/message"

export interface SubtaskInput {
  parentSessionID: string
  agent: string
  prompt: string
  description: string
  abort: AbortSignal
  /** Continue an earlier subagent session instead of starting a new one. */
  resume?: string
}

export interface SubtaskResult {
  sessionID: string
  text: string
}

/** Wired up by the session layer; the tool cannot import it directly without a cycle. */
let runner: ((input: SubtaskInput) => Promise<SubtaskResult>) | undefined

export function setSubtaskRunner(fn: (input: SubtaskInput) => Promise<SubtaskResult>) {
  runner = fn
}

export async function createTaskTool(exclude?: string): Promise<ToolDefinition | undefined> {
  const agents = (await subAgents()).filter((a) => a.name !== exclude)
  if (agents.length === 0) return undefined
  return defineTool<{ description: string; prompt: string; subagent_type: string; task_id?: string }>({
    id: "task",
    description: `Launch a subagent to handle a task autonomously in its own context window. The subagent works on its own and returns a single final report.

Available agent types:
${agents.map((a) => `- ${a.name}: ${a.description ?? "No description."}`).join("\n")}

When to use it:
- Broad codebase exploration or research that would take many searches and fill your context with file dumps.
- Independent pieces of work that can run side by side: launch several subagents in ONE turn by making multiple task calls.

When not to use it:
- Reading a specific file, or searching for one symbol: use read, grep or glob directly, it is faster.
- Work that needs your accumulated context, or back-and-forth with the user.

Usage notes:
- The subagent starts with no knowledge of this conversation. Write a self-contained prompt: the goal, relevant paths, constraints, and exactly what it should report back.
- Say whether you expect it to write code or only to research.
- Its report is returned to you, not shown to the user: relay what matters.
- To continue a previous subagent with its context intact, pass its task_id.`,
    parameters: {
      type: "object",
      required: ["description", "prompt", "subagent_type"],
      properties: {
        description: { type: "string", description: "A short (3-5 word) description of the task" },
        prompt: { type: "string", description: "The complete task for the subagent to perform" },
        subagent_type: { type: "string", description: "Which agent type to use" },
        task_id: { type: "string", description: "Resume a previous subagent session by the id it returned" },
      },
    },
    async execute(args, ctx) {
      if (!runner) throw new Error("Subagents are not available in this context.")
      const agent = agents.find((a) => a.name === args.subagent_type)
      if (!agent) {
        throw new ToolInputError(`Unknown agent type "${args.subagent_type}". Available: ${agents.map((a) => a.name).join(", ")}`)
      }
      await ctx.ask({
        permission: "task",
        patterns: [agent.name],
        always: [agent.name],
        title: `${agent.name}: ${args.description}`,
        metadata: { agent: agent.name, description: args.description },
      })

      // Mirror the subagent's tool activity into this call so the user can watch it work.
      const summary = new Map<string, { tool: string; title: string; status: string }>()
      let childID: string | undefined
      const unsubscribe = subscribe<{ sessionID: string; part: ToolPart }>("message.part.updated", (event) => {
        const { sessionID, part } = event.properties
        if (!childID || sessionID !== childID || part.type !== "tool") return
        const state = part.state
        summary.set(part.id, {
          tool: part.tool,
          status: state.status,
          title: state.status === "completed" || state.status === "running" ? (state.title ?? "") : "",
        })
        ctx.metadata({ title: args.description, metadata: { sessionID: childID, agent: agent.name, summary: [...summary.values()] } })
      })
      const unsubscribeCreated = subscribe<{ info: { id: string; parentID?: string } }>("session.created", (event) => {
        if (!childID && event.properties.info.parentID === ctx.sessionID) {
          childID = event.properties.info.id
          ctx.metadata({ title: args.description, metadata: { sessionID: childID, agent: agent.name, summary: [] } })
        }
      })
      if (args.task_id) childID = args.task_id

      try {
        const result = await runner({
          parentSessionID: ctx.sessionID,
          agent: agent.name,
          prompt: args.prompt,
          description: args.description,
          abort: ctx.abort,
          resume: args.task_id,
        })
        return {
          title: args.description,
          output: `${result.text || "(the subagent returned no text)"}\n\n<task_metadata>\ntask_id: ${result.sessionID}\n</task_metadata>`,
          metadata: { sessionID: result.sessionID, agent: agent.name, summary: [...summary.values()] },
        }
      } finally {
        unsubscribe()
        unsubscribeCreated()
      }
    },
  })
}
