/**
 * Types for writing a Deberopa plugin.
 *
 *   // ~/.config/deberopa/plugin/hello.js
 *   /** @type {import("@deberopa/sdk").Plugin} *\/
 *   export default async ({ directory }) => ({
 *     tool: {
 *       shout: {
 *         description: "Upper-case a string",
 *         parameters: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
 *         execute: async ({ text }) => text.toUpperCase(),
 *       },
 *     },
 *     "tool.execute.before": async ({ tool }, output) => {
 *       if (tool === "bash" && /rm -rf/.test(output.args.command)) throw new Error("no rm -rf")
 *     },
 *   })
 *
 * Plugins are loaded from ~/.config/deberopa/plugin (Windows: %APPDATA%\\deberopa\\plugin), from the
 * "plugin" setting (file paths), and from .deberopa/plugin in a project you have trusted
 * (`deberopa trust`). They run with your full rights.
 */

export interface PluginContext {
  directory: string
  worktree: string
  version: string
  log: { info(message: string): void; warn(message: string): void; error(message: string): void }
}

export interface PluginToolContext {
  sessionID: string
  messageID: string
  callID: string
  agent: string
  abort: AbortSignal
  directory: string
  worktree: string
  /** Ask the user for permission; rejects when they say no. */
  ask(request: { permission: string; patterns: string[]; title: string; always?: string[]; metadata?: Record<string, unknown> }): Promise<void>
  /** Show progress while the tool runs. */
  metadata(update: { title?: string; metadata?: Record<string, unknown> }): void
}

export interface PluginTool {
  description: string
  /** JSON Schema of the arguments, with type "object". */
  parameters: Record<string, unknown>
  execute(args: any, ctx: PluginToolContext): Promise<string | { title?: string; output: string; metadata?: Record<string, unknown> }> | string
}

export interface PluginHooks {
  tool?: Record<string, PluginTool>
  event?(event: { type: string; properties: any }): void | Promise<void>
  "tool.execute.before"?(input: { tool: string; sessionID: string; callID: string }, output: { args: any }): void | Promise<void>
  "tool.execute.after"?(
    input: { tool: string; sessionID: string; callID: string },
    output: { title: string; output: string; metadata: Record<string, unknown> },
  ): void | Promise<void>
  "chat.system"?(input: { agent: string; providerID: string; modelID: string }, output: { system: string[] }): void | Promise<void>
}

export type Plugin = (context: PluginContext) => PluginHooks | Promise<PluginHooks>
