import path from "node:path"
import { project } from "../project"
import { createLogger } from "../util/log"
import { publish } from "../util/bus"
import { isInside } from "../util/fs"

const log = createLogger("pty")

/**
 * Interactive terminals for clients that show one (Deberopa Desktop). Output and the exit arrive on
 * the event stream as `pty.data` and `pty.exit`. A terminal runs the user's own shell in the
 * project folder, with the same trust as the `shell` route: this server is local, or password
 * protected. Where Bun cannot give a pseudo-terminal (it may not on Windows) the shell runs on
 * plain pipes, which `pty: false` tells the client so it can echo typed text itself.
 */

export interface PtyInfo {
  id: string
  shell: string
  cwd: string
  pty: boolean
}

interface Entry extends PtyInfo {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

const terminals = new Map<string, Entry>()
export const MAX_TERMINALS = 8
let counter = 0

function userShell(): { cmd: string; args: string[] } {
  if (process.platform === "win32") {
    const ps = Bun.which("pwsh") ?? Bun.which("powershell")
    return ps ? { cmd: ps, args: ["-NoLogo"] } : { cmd: process.env.COMSPEC ?? "cmd.exe", args: [] }
  }
  const shell = process.env.SHELL && path.isAbsolute(process.env.SHELL) ? process.env.SHELL : "/bin/sh"
  return { cmd: shell, args: ["-i"] }
}

export function listTerminals(): PtyInfo[] {
  return [...terminals.values()].map(({ id, shell, cwd, pty }) => ({ id, shell, cwd, pty }))
}

export function openTerminal(opts: { cwd?: string; cols?: number; rows?: number } = {}): PtyInfo {
  if (terminals.size >= MAX_TERMINALS) throw new Error(`At most ${MAX_TERMINALS} terminals can be open; close one first.`)
  const root = project().worktree
  const cwd = opts.cwd ? path.resolve(root, opts.cwd) : project().directory
  if (!isInside(root, cwd)) throw new Error("The terminal's folder must be inside the project.")
  const cols = Math.min(500, Math.max(2, Math.floor(opts.cols ?? 80)))
  const rows = Math.min(200, Math.max(2, Math.floor(opts.rows ?? 24)))
  const id = `term_${Date.now().toString(36)}${(counter++).toString(36)}`
  const { cmd, args } = userShell()
  const env = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" } as Record<string, string>
  // the server's own secrets stay out of an interactive shell the page can type into
  for (const key of Object.keys(env)) if (key === "DEBEROPA_SERVER_PASSWORD") delete env[key]

  const decoder = new TextDecoder()
  const emit = (data: Uint8Array) => {
    const text = decoder.decode(data, { stream: true })
    if (text) publish("pty.data", { id, data: text })
  }
  const done = (code: number | null) => {
    terminals.delete(id)
    publish("pty.exit", { id, code })
  }

  let entry: Entry
  try {
    const proc = Bun.spawn([cmd, ...args], {
      cwd,
      env,
      terminal: { cols, rows, data: (_t: unknown, data: Uint8Array) => emit(data) },
    } as any)
    const term = (proc as any).terminal
    if (!term) throw new Error("no terminal support")
    entry = {
      id,
      shell: cmd,
      cwd,
      pty: true,
      write: (d) => term.write(d),
      resize: (c, r) => term.resize?.(c, r),
      kill: () => proc.kill(),
    }
    void proc.exited.then((code) => done(code))
  } catch (err) {
    log.warn("no pseudo-terminal, using pipes", err instanceof Error ? err.message : String(err))
    const proc = Bun.spawn([cmd, ...args], { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
    const pump = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader()
      for (;;) {
        const { done: finished, value } = await reader.read()
        if (finished) return
        emit(value)
      }
    }
    void pump(proc.stdout as ReadableStream<Uint8Array>)
    void pump(proc.stderr as ReadableStream<Uint8Array>)
    entry = {
      id,
      shell: cmd,
      cwd,
      pty: false,
      write: (d) => {
        ;(proc.stdin as any).write(d)
        ;(proc.stdin as any).flush?.()
      },
      resize: () => {},
      kill: () => proc.kill(),
    }
    void proc.exited.then((code) => done(code))
  }
  terminals.set(id, entry)
  return { id, shell: entry.shell, cwd: entry.cwd, pty: entry.pty }
}

export function writeTerminal(id: string, data: string): boolean {
  const entry = terminals.get(id)
  if (!entry) return false
  entry.write(data)
  return true
}

export function resizeTerminal(id: string, cols: number, rows: number): boolean {
  const entry = terminals.get(id)
  if (!entry) return false
  entry.resize(Math.min(500, Math.max(2, Math.floor(cols))), Math.min(200, Math.max(2, Math.floor(rows))))
  return true
}

export function closeTerminal(id: string): boolean {
  const entry = terminals.get(id)
  if (!entry) return false
  entry.kill()
  terminals.delete(id)
  return true
}

/** Server shutdown and tests: no shell outlives its server. */
export function closeAllTerminals() {
  for (const entry of terminals.values()) entry.kill()
  terminals.clear()
}

process.on("exit", closeAllTerminals)
