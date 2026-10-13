import path from "node:path"
import React from "react"
import { render } from "ink"
import { parse, UsageError, type CommandSpec } from "../args"
import { bootstrap } from "../bootstrap"
import { parseModelRef } from "../../provider/provider"
import { getSession, listSessions } from "../../session/store"
import { App } from "../../tui/app"
import { app } from "../../tui/state"

export const spec: CommandSpec = {
  usage: "vedecaps [project] [options]",
  description: "start the terminal UI",
  options: {
    continue: { type: "boolean", short: "c", description: "continue the last session" },
    session: { type: "string", short: "s", arg: "id", description: "continue a specific session" },
    model: { type: "string", short: "m", arg: "provider/model", description: "model to use" },
    agent: { type: "string", arg: "name", description: "agent to start with" },
    prompt: { type: "string", short: "p", arg: "text", description: "send this prompt as soon as the UI opens" },
    "print-logs": { type: "boolean", description: "print the log to stderr" },
  },
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, spec.options!)
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new UsageError('The terminal UI needs an interactive terminal. For scripts and pipes use: vedecaps run "your request"')
  }
  await bootstrap({ directory: positionals[0] ? path.resolve(positionals[0]) : undefined, printLogs: values["print-logs"], mcp: "background" })

  let sessionID: string | undefined = values.session
  if (sessionID && !(await getSession(sessionID))) throw new UsageError(`Session not found: ${sessionID}`)
  if (!sessionID && values.continue) sessionID = (await listSessions())[0]?.id

  let model: { providerID: string; modelID: string } | undefined
  if (values.model) {
    model = parseModelRef(values.model)
    if (!model.providerID) throw new UsageError(`--model must look like provider/model, e.g. anthropic/claude-sonnet-5-5`)
  }

  const instance = render(React.createElement(App, { options: { sessionID, initialPrompt: values.prompt, agent: values.agent, model } }), {
    exitOnCtrlC: false,
    patchConsole: true,
    incrementalRendering: true,
  })
  await instance.waitUntilExit()
  if (app.session) process.stdout.write(`\nResume this session with: vedecaps -s ${app.session.id}\n`)
  return 0
}
