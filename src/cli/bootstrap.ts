import { ensureDirs } from "../global"
import { initProject, type Project } from "../project"
import { initLog } from "../util/log"
import { flush } from "../session/store"
import { shutdownLsp } from "../lsp"
import { shutdownMcp, startMcp } from "../mcp"
import { cancel, busySessions } from "../session/prompt"

export interface BootstrapOptions {
  directory?: string
  /** Mirror the log to stderr (for `--print-logs`). */
  printLogs?: boolean
  /** Connect MCP servers and wait for them. */
  mcp?: boolean | "background"
}

export async function bootstrap(opts: BootstrapOptions = {}): Promise<Project> {
  ensureDirs()
  initLog({ print: opts.printLogs })
  const project = initProject(opts.directory ?? process.cwd())
  if (opts.mcp === true) await startMcp()
  else if (opts.mcp === "background") void startMcp()
  return project
}

let shuttingDown: Promise<void> | undefined

/** Stop child processes (LSP, MCP, running turns) and write pending state. Safe to call twice. */
export function shutdown(): Promise<void> {
  return (shuttingDown ??= (async () => {
    for (const id of busySessions()) cancel(id)
    await Promise.race([
      Promise.allSettled([flush(), shutdownLsp(), shutdownMcp()]),
      new Promise((resolve) => setTimeout(resolve, 4000).unref?.()),
    ])
  })())
}

/** Run `fn`, always clean up, and exit with the code it returns. */
export async function runAndExit(fn: () => Promise<number | void>): Promise<never> {
  let code = 0
  const onSignal = () => {
    void shutdown().finally(() => process.exit(130))
  }
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)
  try {
    code = (await fn()) ?? 0
  } catch (err) {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`)
    code = 1
  }
  await shutdown()
  process.exit(code)
}
