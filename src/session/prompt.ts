import fs from "node:fs/promises"
import path from "node:path"
import { createID } from "../util/id"
import { publish } from "../util/bus"
import { createLogger } from "../util/log"
import { getConfig, writeState } from "../config/config"
import { defaultAgentName, getAgent, subAgents, type AgentInfo } from "../agent/agent"
import { defaultModel, getModel, smallModel } from "../provider/provider"
import { generateText, streamModel } from "../provider/stream"
import { costOf, EMPTY_USAGE, ProviderError, type Model, type ProviderInfo } from "../provider/types"
import { askPermission, rejectPending } from "../permission/permission"
import { toolsFor } from "../tool/registry"
import { coerceArgs, PermissionDeniedError, validateArgs, type ToolContext, type ToolDefinition } from "../tool/tool"
import { ReadTool } from "../tool/read"
import { ListTool } from "../tool/list"
import { BashTool } from "../tool/bash"
import { setSubtaskRunner } from "../tool/task"
import { changedFiles, track } from "../snapshot/snapshot"
import { project } from "../project"
import { compact, shouldCompact } from "./compaction"
import { toModelMessages } from "./convert"
import { runHook } from "../plugin"
import { COMPACT_DROPPED_TOOLS, MAX_STEPS_REMINDER, shortenDescription, systemPrompt, useCompactPrompt } from "./system"
import {
  addMessage,
  createSession,
  flush,
  getMessages,
  getSession,
  isDefaultTitle,
  removeMessage,
  requireSession,
  touchMessage,
  updateSession,
} from "./store"
import {
  messageText,
  type AssistantMessage,
  type FilePart,
  type Message,
  type Part,
  type ReasoningPart,
  type TextPart,
  type ToolPart,
  type UserMessage,
} from "./message"

const log = createLogger("session")

const MAX_RETRIES = 6
const DOOM_LOOP_THRESHOLD = 3

interface RunState {
  abort: AbortController
}

const running = new Map<string, RunState>()

export class BusyError extends Error {
  constructor(sessionID: string) {
    super(`Session ${sessionID} is busy`)
    this.name = "BusyError"
  }
}

export class NoModelError extends Error {
  constructor() {
    super("No model is configured. Run `vedecaps auth login` to add a provider, or set an API key such as ANTHROPIC_API_KEY.")
    this.name = "NoModelError"
  }
}

export function isBusy(sessionID: string) {
  return running.has(sessionID)
}

export function busySessions(): string[] {
  return [...running.keys()]
}

/** Stop a running session (and anything waiting on the user for it). */
export function cancel(sessionID: string) {
  const state = running.get(sessionID)
  if (!state) return false
  state.abort.abort()
  rejectPending(sessionID)
  return true
}

function setStatus(sessionID: string, status: { type: "busy" } | { type: "idle" } | { type: "retry"; attempt: number; message: string; next: number }) {
  publish("session.status", { sessionID, status })
}

/** The session at the top of a subagent chain: "always allow" answers are remembered there. */
async function rootSessionID(sessionID: string): Promise<string> {
  let current = sessionID
  for (let i = 0; i < 10; i++) {
    const info = await getSession(current)
    if (!info?.parentID) return current
    current = info.parentID
  }
  return current
}

export interface PromptInput {
  sessionID: string
  text: string
  files?: { mime: string; filename?: string; data: string }[]
  agent?: string
  model?: { providerID: string; modelID: string }
  /** Extra instructions added as synthetic text (hidden from the transcript, visible to the model). */
  synthetic?: string[]
}

/** Resolve which agent and model a new message should use. */
export async function resolveTarget(sessionID: string, input: { agent?: string; model?: { providerID: string; modelID: string } }) {
  const messages = await getMessages(sessionID)
  const lastUser = [...messages].reverse().find((m): m is UserMessage => m.role === "user")
  const agentName = input.agent ?? lastUser?.agent ?? (await defaultAgentName())
  const agent = (await getAgent(agentName)) ?? (await getAgent(await defaultAgentName()))
  if (!agent) throw new Error(`Agent not found: ${agentName}`)
  const model = input.model ?? agent.model ?? lastUser?.model ?? (await defaultModel())
  if (!model) throw new NoModelError()
  return { agent, model }
}

const MENTION = /(?<![\w`/])@([^\s@`,;:!?()[\]{}<>"']+(?:\.[\w-]+)?)/g

/** `src/a.ts#L10-20` (or `#L10`) -> the path and a 1-based inclusive line range. */
export function splitLineRange(raw: string): { target: string; start?: number; end?: number } {
  const m = /^(.*?)#L(\d+)(?:-L?(\d+))?$/.exec(raw)
  if (!m) return { target: raw }
  const start = Number(m[2])
  const end = m[3] ? Number(m[3]) : start
  return { target: m[1]!, start: Math.min(start, end), end: Math.max(start, end) }
}

/** Turn `@path` mentions into attached content, the same way the model would have fetched it. */
async function resolveMentions(sessionID: string, text: string, agentName: string): Promise<Part[]> {
  const parts: Part[] = []
  const { directory, worktree } = project()
  const seen = new Set<string>()
  const agents = await subAgents()
  const ctx: ToolContext = {
    sessionID,
    messageID: "",
    callID: "",
    agent: agentName,
    abort: new AbortController().signal,
    directory,
    worktree,
    ask: async () => {},
    metadata: () => {},
  }
  for (const match of text.matchAll(MENTION)) {
    const raw = (match[1] ?? "").replace(/[.]+$/, "")
    if (!raw || seen.has(raw)) continue
    seen.add(raw)

    const subagent = agents.find((a) => a.name === raw)
    if (subagent) {
      parts.push({
        id: createID("part"),
        type: "text",
        synthetic: true,
        text: `Use the above message and context to write a prompt and call the task tool with subagent_type "${subagent.name}".`,
      })
      continue
    }

    const ranged = splitLineRange(raw)
    const target = path.isAbsolute(ranged.target) ? ranged.target : path.resolve(directory, ranged.target)
    const stat = await fs.stat(target).catch(() => undefined)
    if (!stat) continue
    try {
      if (stat.isDirectory()) {
        const result = await ListTool.execute({ path: target }, ctx)
        parts.push({
          id: createID("part"),
          type: "text",
          synthetic: true,
          text: `Called the list tool with the following input: ${JSON.stringify({ path: target })}\n\n${result.output}`,
        })
        continue
      }
      const readArgs = ranged.start ? { filePath: target, offset: ranged.start, limit: ranged.end! - ranged.start + 1 } : { filePath: target }
      const result = await ReadTool.execute(readArgs, ctx)
      if (result.attachments?.length) {
        for (const file of result.attachments) {
          parts.push({ id: createID("part"), type: "file", mime: file.mime, filename: file.filename, data: file.data } satisfies FilePart)
        }
      } else {
        parts.push({
          id: createID("part"),
          type: "text",
          synthetic: true,
          text: `Called the read tool with the following input: ${JSON.stringify(readArgs)}\n\n${result.output}`,
        })
      }
    } catch (err) {
      parts.push({
        id: createID("part"),
        type: "text",
        synthetic: true,
        text: `The file ${target} was mentioned but could not be read: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }
  return parts
}

/** Drop the messages hidden by an undo once the user moves on with a new prompt. */
async function settleRevert(sessionID: string) {
  const session = await requireSession(sessionID)
  if (!session.revert) return
  const cut = session.revert.messageID
  const messages = await getMessages(sessionID)
  for (const message of messages.filter((m) => m.id >= cut)) await removeMessage(sessionID, message.id)
  await updateSession(sessionID, (info) => {
    delete info.revert
  })
}

/** Send a user message and run the agent until it stops. Resolves with the final assistant message. */
export async function prompt(input: PromptInput): Promise<AssistantMessage | undefined> {
  if (running.has(input.sessionID)) throw new BusyError(input.sessionID)
  const session = await requireSession(input.sessionID)
  // Claim the session before any await that could let a second prompt slip in.
  const state: RunState = { abort: new AbortController() }
  running.set(input.sessionID, state)
  setStatus(input.sessionID, { type: "busy" })
  try {
    await settleRevert(input.sessionID)
    const { agent, model } = await resolveTarget(input.sessionID, input)
    // Fail early (and clearly) when the provider has no credentials.
    await getModel(model.providerID, model.modelID)

    const existing = await getMessages(input.sessionID)
    const first = !existing.some((m) => m.role === "user")
    const parts: Part[] = [{ id: createID("part"), type: "text", text: input.text }]
    for (const file of input.files ?? []) parts.push({ id: createID("part"), type: "file", ...file })
    parts.push(...(await resolveMentions(input.sessionID, input.text, agent.name)))
    for (const text of input.synthetic ?? []) parts.push({ id: createID("part"), type: "text", text, synthetic: true })

    const user: UserMessage = {
      id: createID("message"),
      sessionID: input.sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: agent.name,
      model,
      parts,
    }
    await addMessage(user)
    await updateSession(input.sessionID, () => {})
    if (!session.parentID) {
      void writeState({ model, agent: agent.mode === "subagent" ? undefined : agent.name }).catch(() => {})
      if (first && isDefaultTitle(session.title)) void generateTitle(input.sessionID, input.text, model).catch((err) => log.warn("title failed", err))
    }
    return await loop(input.sessionID, state)
  } catch (err) {
    if (!(err instanceof BusyError)) publish("session.error", { sessionID: input.sessionID, error: errorInfo(err) })
    throw err
  } finally {
    running.delete(input.sessionID)
    await flush()
    setStatus(input.sessionID, { type: "idle" })
    publish("session.idle", { sessionID: input.sessionID })
  }
}

function errorInfo(err: unknown): { name: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message }
  return { name: "Error", message: String(err) }
}

function isAbort(err: unknown, signal: AbortSignal) {
  return signal.aborted || (err instanceof Error && err.name === "AbortError")
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    signal.addEventListener("abort", done, { once: true })
  })
}

async function loop(sessionID: string, state: RunState): Promise<AssistantMessage | undefined> {
  const signal = state.abort.signal
  const config = await getConfig()
  let step = 0
  let last: AssistantMessage | undefined

  while (!signal.aborted) {
    const messages = await getMessages(sessionID)
    const lastUser = [...messages].reverse().find((m): m is UserMessage => m.role === "user")
    if (!lastUser) break
    const agent = (await getAgent(lastUser.agent)) ?? (await getAgent(await defaultAgentName()))
    if (!agent) throw new Error(`Agent not found: ${lastUser.agent}`)
    const { provider, model } = await getModel(lastUser.model.providerID, lastUser.model.modelID)

    const previous = [...messages].reverse().find((m): m is AssistantMessage => m.role === "assistant" && !!m.time.completed && !m.error)
    if (previous && !previous.summary && config.compaction?.auto !== false && shouldCompact(previous.tokens, model, config.compaction?.reserved)) {
      await compact({ sessionID, signal, auto: true })
      continue
    }

    step++
    const finalStep = agent.steps !== undefined && step >= agent.steps
    const outcome = await runStep({ sessionID, agent, provider, model, parent: lastUser, signal, finalStep, config })
    if (outcome.message) last = outcome.message
    if (outcome.next === "compact") {
      await compact({ sessionID, signal, auto: true })
      continue
    }
    if (outcome.next === "stop" || finalStep) break
  }
  return last
}

interface StepInput {
  sessionID: string
  agent: AgentInfo
  provider: ProviderInfo
  model: Model
  parent: UserMessage
  signal: AbortSignal
  finalStep: boolean
  config: Awaited<ReturnType<typeof getConfig>>
}

async function runStep(input: StepInput): Promise<{ next: "continue" | "stop" | "compact"; message?: AssistantMessage }> {
  const { sessionID, agent, provider, model, signal } = input
  const compact = useCompactPrompt(provider, model)
  let tools = input.finalStep ? [] : model.toolCall ? await toolsFor(agent) : []
  if (compact) tools = tools.filter((t) => !COMPACT_DROPPED_TOOLS.has(t.id))
  const system = await systemPrompt({ agent, model, compact })
  await runHook("chat.system", { agent: agent.name, providerID: provider.id, modelID: model.id }, { system })
  const history = toModelMessages(await getMessages(sessionID))
  if (input.finalStep) history.push({ role: "user", content: [{ type: "text", text: MAX_STEPS_REMINDER }] })

  const assistant: AssistantMessage = {
    id: createID("message"),
    sessionID,
    role: "assistant",
    parentID: input.parent.id,
    time: { created: Date.now() },
    agent: agent.name,
    providerID: provider.id,
    modelID: model.id,
    parts: [],
    tokens: { ...EMPTY_USAGE },
    cost: 0,
  }
  const snapshot = await track()
  assistant.parts.push({ id: createID("part"), type: "step-start", snapshot })
  await addMessage(assistant)

  const approvalScope = await rootSessionID(sessionID)
  const executions: Promise<void>[] = []
  let halted = false

  const execute = async (part: ToolPart, tool: ToolDefinition | undefined, args: unknown, invalid?: string) => {
    const start = Date.now()
    const fail = async (message: string) => {
      part.state = { status: "error", input: args, error: message, time: { start, end: Date.now() } }
      await touchMessage(assistant, { part })
    }
    if (invalid) return fail(invalid)
    if (!tool) return fail(`Unknown tool "${part.tool}". Available tools: ${tools.map((t) => t.id).join(", ")}`)
    const coerced = coerceArgs(tool.parameters, args && typeof args === "object" ? args : {})
    const problem = validateArgs(tool.parameters, coerced)
    if (problem) return fail(`Invalid input for ${tool.id}: ${problem}. Fix the arguments and call the tool again.`)

    part.state = { status: "running", input: coerced, time: { start } }
    await touchMessage(assistant, { part })
    const ctx: ToolContext = {
      sessionID,
      messageID: assistant.id,
      callID: part.callID,
      agent: agent.name,
      abort: signal,
      directory: project().directory,
      worktree: project().worktree,
      ask: (request) => askPermission({ ...request, sessionID, ruleset: agent.permission, approvalScope }),
      metadata: (update) => {
        if (part.state.status !== "running") return
        if (update.title !== undefined) part.state.title = update.title
        if (update.metadata) part.state.metadata = { ...part.state.metadata, ...update.metadata }
        void touchMessage(assistant, { part })
      },
    }
    try {
      if (await isDoomLoop(sessionID, part.tool, coerced)) {
        await ctx.ask({
          permission: "doom_loop",
          patterns: [part.tool],
          title: `${part.tool} has been called ${DOOM_LOOP_THRESHOLD} times in a row with identical input. Continue?`,
          metadata: { tool: part.tool, input: coerced },
        })
      }
      // plugins may rewrite the arguments, or throw to veto the call
      const hookInput = { tool: tool.id, sessionID, callID: part.callID }
      const rewritten = { args: coerced }
      await runHook("tool.execute.before", hookInput, rewritten)
      const finalArgs = rewritten.args
      if (finalArgs !== coerced) {
        const again = validateArgs(tool.parameters, finalArgs)
        if (again) throw new Error(`A plugin changed the arguments of ${tool.id} into something invalid: ${again}`)
        part.state = { status: "running", input: finalArgs, time: { start } }
      }
      const result = await tool.execute(finalArgs, ctx)
      if (signal.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" })
      const shaped = { title: result.title, output: result.output, metadata: result.metadata ?? {} }
      await runHook("tool.execute.after", hookInput, shaped)
      part.state = {
        status: "completed",
        input: finalArgs,
        output: shaped.output,
        title: shaped.title,
        metadata: shaped.metadata,
        time: { start, end: Date.now() },
        attachments: result.attachments?.length ? result.attachments : undefined,
      }
      await touchMessage(assistant, { part })
    } catch (err) {
      if (err instanceof PermissionDeniedError && err.byUser) halted = true
      const message = isAbort(err, signal) ? "The tool call was interrupted by the user." : err instanceof Error ? err.message : String(err)
      await fail(message)
    }
  }

  let finish: string | undefined
  let refusal: string | undefined
  let text: TextPart | undefined
  let reasoning: ReasoningPart | undefined

  for (let attempt = 1; ; attempt++) {
    text = undefined
    reasoning = undefined
    try {
      const stream = streamModel({
        provider,
        model,
        system,
        messages: history,
        tools: tools.map((t) => ({ name: t.id, description: compact ? shortenDescription(t.description) : t.description, parameters: t.parameters })),
        signal,
        temperature: agent.temperature,
        topP: agent.topP,
        effort: agent.effort ?? input.config.reasoning_effort,
      })
      for await (const event of stream) {
        switch (event.type) {
          case "text-delta": {
            if (reasoning) {
              reasoning.time.end = Date.now()
              reasoning = undefined
            }
            if (!text) {
              text = { id: createID("part"), type: "text", text: "" }
              assistant.parts.push(text)
            }
            text.text += event.text
            await touchMessage(assistant, { part: text, delta: event.text })
            break
          }
          case "reasoning-delta": {
            text = undefined
            if (!reasoning) {
              reasoning = { id: createID("part"), type: "reasoning", text: "", time: { start: Date.now() } }
              assistant.parts.push(reasoning)
            }
            reasoning.text += event.text
            await touchMessage(assistant, { part: reasoning, delta: event.text })
            break
          }
          case "reasoning-end": {
            if (reasoning) {
              reasoning.time.end = Date.now()
              await touchMessage(assistant, { part: reasoning })
              reasoning = undefined
            }
            break
          }
          case "tool-input-start": {
            text = undefined
            const part: ToolPart = { id: createID("part"), type: "tool", callID: event.id, tool: event.name, state: { status: "pending", input: {} } }
            assistant.parts.push(part)
            await touchMessage(assistant, { part })
            break
          }
          case "tool-call": {
            text = undefined
            let part = assistant.parts.find((p): p is ToolPart => p.type === "tool" && p.callID === event.id)
            if (!part) {
              part = { id: createID("part"), type: "tool", callID: event.id, tool: event.name, state: { status: "pending", input: event.input } }
              assistant.parts.push(part)
            }
            part.state = { status: "pending", input: event.input }
            if (event.meta) part.meta = event.meta
            executions.push(execute(part, tools.find((t) => t.id === event.name), event.input, event.invalid))
            break
          }
          case "finish": {
            assistant.tokens = event.usage
            assistant.cost = costOf(model, event.usage)
            assistant.raw = event.raw
            finish = event.reason
            if (event.reason === "refusal") refusal = event.message ?? "The model declined to respond."
            break
          }
        }
      }
      break
    } catch (err) {
      if (isAbort(err, signal)) break
      if (err instanceof ProviderError && err.kind === "context-overflow") {
        // Nothing useful was produced: discard this step and let the caller compact.
        await removeMessage(sessionID, assistant.id)
        const hasHistory = history.length > 2
        if (hasHistory) return { next: "compact" }
      }
      const started = executions.length > 0
      if (err instanceof ProviderError && err.retryable && attempt < MAX_RETRIES && !started) {
        const delay = Math.min(err.retryAfterMs ?? 2000 * 2 ** (attempt - 1), 60_000)
        log.warn(`retrying after error (attempt ${attempt})`, err.message)
        setStatus(sessionID, { type: "retry", attempt, message: err.message, next: Date.now() + delay })
        // Start the step over: partial output from a failed attempt would be duplicated otherwise.
        assistant.parts = assistant.parts.filter((p) => p.type === "step-start")
        await touchMessage(assistant)
        await sleep(delay, signal)
        setStatus(sessionID, { type: "busy" })
        if (signal.aborted) break
        continue
      }
      log.error("step failed", err)
      assistant.error = errorInfo(err)
      assistant.time.completed = Date.now()
      await touchMessage(assistant, { now: true })
      publish("session.error", { sessionID, error: assistant.error })
      return { next: "stop", message: assistant }
    }
  }

  await Promise.all(executions)
  if (reasoning && !reasoning.time.end) reasoning.time.end = Date.now()

  // Calls that never got to run (cancelled mid-stream) must not be left dangling.
  for (const part of assistant.parts) {
    if (part.type === "tool" && (part.state.status === "pending" || part.state.status === "running")) {
      part.state = { status: "error", input: part.state.input, error: "The tool call was interrupted.", time: { start: Date.now(), end: Date.now() } }
    }
  }

  if (snapshot) {
    const files = await changedFiles(snapshot).catch(() => [] as string[])
    if (files.length) assistant.parts.push({ id: createID("part"), type: "patch", hash: snapshot, files })
  }

  assistant.finish = signal.aborted ? "aborted" : finish
  if (refusal) assistant.error = { name: "Refusal", message: refusal }
  if (signal.aborted && !assistant.error) assistant.error = { name: "Aborted", message: "Interrupted" }
  if (finish === "length" && executions.length === 0) {
    assistant.error = { name: "OutputLimit", message: "The response hit the model's output limit and was cut off. Ask it to continue." }
  }
  assistant.time.completed = Date.now()
  await touchMessage(assistant, { now: true })
  await updateSession(sessionID, () => {})

  if (signal.aborted || refusal || halted) return { next: "stop", message: assistant }
  const hasTools = assistant.parts.some((p) => p.type === "tool")
  return { next: hasTools ? "continue" : "stop", message: assistant }
}

async function isDoomLoop(sessionID: string, tool: string, input: unknown): Promise<boolean> {
  const messages = await getMessages(sessionID)
  const recent: ToolPart[] = []
  for (let i = messages.length - 1; i >= 0 && recent.length < DOOM_LOOP_THRESHOLD; i--) {
    const message = messages[i]!
    if (message.role !== "assistant") break
    for (let j = message.parts.length - 1; j >= 0 && recent.length < DOOM_LOOP_THRESHOLD; j--) {
      const part = message.parts[j]!
      if (part.type === "tool" && part.state.status !== "pending" && part.state.status !== "running") recent.push(part)
    }
  }
  if (recent.length < DOOM_LOOP_THRESHOLD) return false
  const key = JSON.stringify(input)
  return recent.every((p) => p.tool === tool && JSON.stringify(p.state.input) === key)
}

const TITLE_SYSTEM = `You generate short titles for coding conversations. Reply with the title only: at most 6 words, in the language of the message, no quotes, no trailing punctuation, no explanation. Describe the task, not the conversation.`

async function generateTitle(sessionID: string, text: string, main: { providerID: string; modelID: string }) {
  const fallback = text.replace(/\s+/g, " ").trim().slice(0, 60)
  let title = fallback
  try {
    const ref = await smallModel(main.providerID, main.modelID)
    const { provider, model } = await getModel(ref.providerID, ref.modelID)
    const result = await generateText({
      provider,
      model,
      system: [TITLE_SYSTEM],
      messages: [{ role: "user", content: [{ type: "text", text: `Write a title for a conversation that starts with this message:\n\n${text.slice(0, 2000)}` }] }],
      effort: "low",
      signal: AbortSignal.timeout(30_000),
    })
    const line = result.split("\n").map((l) => l.trim()).find(Boolean)
    if (line) title = line.replace(/^["'`]+|["'`.]+$/g, "").slice(0, 80)
  } catch (err) {
    log.warn("title generation failed", err)
  }
  if (!title) return
  const session = await getSession(sessionID)
  if (session && isDefaultTitle(session.title)) await updateSession(sessionID, (info) => (info.title = title))
}

/** Run a shell command on the user's behalf (`!cmd`) and record it so the model sees the result. */
export async function shell(input: { sessionID: string; command: string; agent?: string }): Promise<ToolPart> {
  if (running.has(input.sessionID)) throw new BusyError(input.sessionID)
  const state: RunState = { abort: new AbortController() }
  running.set(input.sessionID, state)
  setStatus(input.sessionID, { type: "busy" })
  try {
    await settleRevert(input.sessionID)
    const { agent, model } = await resolveTarget(input.sessionID, { agent: input.agent }).catch(async () => ({
      agent: (await getAgent(await defaultAgentName()))!,
      model: { providerID: "", modelID: "" },
    }))
    const user: UserMessage = {
      id: createID("message"),
      sessionID: input.sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: agent.name,
      model,
      parts: [{ id: createID("part"), type: "text", synthetic: true, text: "The following command was run by the user, not by you. Its output is included for context." }],
    }
    await addMessage(user)
    const part: ToolPart = {
      id: createID("part"),
      type: "tool",
      callID: createID("call"),
      tool: "bash",
      state: { status: "running", input: { command: input.command }, time: { start: Date.now() } },
    }
    const assistant: AssistantMessage = {
      id: createID("message"),
      sessionID: input.sessionID,
      role: "assistant",
      parentID: user.id,
      time: { created: Date.now() },
      agent: agent.name,
      providerID: model.providerID,
      modelID: model.modelID,
      parts: [part],
      tokens: { ...EMPTY_USAGE },
      cost: 0,
    }
    await addMessage(assistant)
    const start = Date.now()
    try {
      const result = await BashTool.execute(
        { command: input.command },
        {
          sessionID: input.sessionID,
          messageID: assistant.id,
          callID: part.callID,
          agent: agent.name,
          abort: state.abort.signal,
          directory: project().directory,
          worktree: project().worktree,
          ask: async () => {}, // the user typed it themselves
          metadata: (update) => {
            if (part.state.status !== "running") return
            part.state.metadata = { ...part.state.metadata, ...update.metadata }
            void touchMessage(assistant, { part })
          },
        },
      )
      part.state = { status: "completed", input: { command: input.command }, output: result.output, title: input.command, metadata: result.metadata ?? {}, time: { start, end: Date.now() } }
    } catch (err) {
      part.state = { status: "error", input: { command: input.command }, error: err instanceof Error ? err.message : String(err), time: { start, end: Date.now() } }
    }
    assistant.time.completed = Date.now()
    assistant.finish = "stop"
    await touchMessage(assistant, { part, now: true })
    return part
  } finally {
    running.delete(input.sessionID)
    await flush()
    setStatus(input.sessionID, { type: "idle" })
  }
}

/** Summarise on demand (`/compact`). */
export async function compactSession(sessionID: string) {
  if (running.has(sessionID)) throw new BusyError(sessionID)
  const state: RunState = { abort: new AbortController() }
  running.set(sessionID, state)
  setStatus(sessionID, { type: "busy" })
  try {
    await settleRevert(sessionID)
    return await compact({ sessionID, signal: state.abort.signal })
  } finally {
    running.delete(sessionID)
    await flush()
    setStatus(sessionID, { type: "idle" })
  }
}

setSubtaskRunner(async (input) => {
  const parent = await requireSession(input.parentSessionID)
  const parentMessages = await getMessages(input.parentSessionID)
  const parentUser = [...parentMessages].reverse().find((m): m is UserMessage => m.role === "user")
  const agent = await getAgent(input.agent)
  if (!agent) throw new Error(`Agent not found: ${input.agent}`)

  let child = input.resume ? await getSession(input.resume) : undefined
  if (input.resume && (!child || child.parentID !== parent.id)) throw new Error(`No subagent session with id ${input.resume} belongs to this conversation.`)
  child ??= await createSession({ parentID: parent.id, title: `${input.description} (@${agent.name} subagent)`, directory: parent.directory })

  const childID = child.id
  const onAbort = () => cancel(childID)
  if (input.abort.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" })
  input.abort.addEventListener("abort", onAbort, { once: true })
  try {
    const message = await prompt({
      sessionID: childID,
      text: input.prompt,
      agent: agent.name,
      // Subagents follow the parent's model unless the agent pins its own.
      model: agent.model ?? parentUser?.model,
    })
    if (message?.error && message.error.name !== "Aborted") throw new Error(`The subagent failed: ${message.error.message}`)
    // The last message may be tool-only; report the newest text the subagent actually wrote.
    const all = await getMessages(childID)
    const text = [...all].reverse().map((m: Message) => (m.role === "assistant" ? messageText(m) : "")).find((t) => t !== "") ?? ""
    return { sessionID: childID, text }
  } finally {
    input.abort.removeEventListener("abort", onAbort)
  }
})
