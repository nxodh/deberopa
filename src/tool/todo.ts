import path from "node:path"
import { Paths } from "../global"
import { publish } from "../util/bus"
import { readJSON, writeJSON } from "../util/fs"
import { defineTool } from "./tool"

export interface TodoItem {
  id: string
  content: string
  status: "pending" | "in_progress" | "completed" | "cancelled"
  priority: "high" | "medium" | "low"
}

type TodoStatus = TodoItem["status"]
type TodoPriority = TodoItem["priority"]

interface TodoWriteArgs {
  todos: Array<{ content: string; status: TodoStatus; priority?: TodoPriority; id?: string }>
}

const STATUSES: TodoStatus[] = ["pending", "in_progress", "completed", "cancelled"]
const PRIORITIES: TodoPriority[] = ["high", "medium", "low"]

function todoFile(sessionID: string): string {
  return path.join(Paths.storage, "todo", sessionID + ".json")
}

export async function getTodos(sessionID: string): Promise<TodoItem[]> {
  const stored = await readJSON<TodoItem[]>(todoFile(sessionID))
  return Array.isArray(stored) ? stored : []
}

export async function setTodos(sessionID: string, todos: TodoItem[]): Promise<void> {
  await writeJSON(todoFile(sessionID), todos)
  publish("todo.updated", { sessionID, todos })
}

function pendingCount(todos: TodoItem[]): number {
  return todos.filter((t) => t.status !== "completed" && t.status !== "cancelled").length
}

export const TodoWriteTool = defineTool<TodoWriteArgs>({
  id: "todowrite",
  description: [
    "Create or replace the todo list for this session. Each call sends the COMPLETE list and replaces the stored one,",
    "so include every item you still need, not only the changed ones.",
    "",
    "When to use it:",
    "- The task has 3 or more distinct steps, or needs careful planning.",
    "- The user gives several tasks at once, as a numbered or comma-separated list.",
    "- The work will span many tool calls and the user benefits from seeing progress.",
    "",
    "When NOT to use it:",
    "- A single straightforward step or a quick question. Just do it.",
    "- Purely informational or conversational requests.",
    "",
    "How to manage the list:",
    "- Statuses: pending, in_progress, completed, cancelled.",
    "- Keep EXACTLY ONE item in_progress at a time. Set the next item to in_progress before you start it.",
    "- Mark an item completed IMMEDIATELY after finishing it. Do not batch completions at the end.",
    "- Mark an item completed only when the work is fully done: tests pass, no unresolved errors, requirements met.",
    "- If an item is blocked or only partly done, keep it in_progress and add a new item that describes the blocker.",
    "- When you discover follow-up work, add it as a new pending item right away.",
    "- Mark items cancelled when they are no longer needed, rather than dropping them silently.",
    "- Write each content line as a short imperative, e.g. \"Add retry logic to the fetch helper\".",
    "- priority is high, medium (default) or low. Use high for work that blocks other items.",
    "- id is optional and is assigned by position when omitted. Reuse the existing id when you update an item.",
  ].join("\n"),
  parameters: {
    type: "object",
    required: ["todos"],
    properties: {
      todos: {
        type: "array",
        description: "The complete todo list. Replaces the previously stored list.",
        items: {
          type: "object",
          required: ["content", "status"],
          properties: {
            content: { type: "string", description: "Short imperative description of the task." },
            status: { type: "string", enum: STATUSES, description: "Current status of the item." },
            priority: { type: "string", enum: PRIORITIES, description: "Priority of the item. Defaults to medium." },
            id: { type: "string", description: "Stable identifier. Assigned by position when omitted." },
          },
        },
      },
    },
  },
  async execute(args, ctx) {
    const todos: TodoItem[] = args.todos.map((item, index) => ({
      id: item.id || String(index + 1),
      content: item.content,
      status: item.status,
      priority: item.priority ?? "medium",
    }))
    await setTodos(ctx.sessionID, todos)
    return {
      title: `${pendingCount(todos)} todos`,
      output: JSON.stringify(todos, null, 2),
      metadata: { todos },
    }
  },
})

export const TodoReadTool = defineTool({
  id: "todoread",
  description:
    "Read the todo list for this session. Use it to recall progress and remaining items, especially in a long conversation.",
  parameters: { type: "object", properties: {} },
  async execute(_args, ctx) {
    const todos = await getTodos(ctx.sessionID)
    return {
      title: `${pendingCount(todos)} todos`,
      output: JSON.stringify(todos, null, 2),
      metadata: { todos },
    }
  },
})
