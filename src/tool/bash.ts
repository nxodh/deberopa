import { spawn } from "node:child_process"
import path from "node:path"
import { defineTool, resolvePath, truncateOutput, assertInsideProject } from "./tool"
import { detectShell, killTree } from "../util/shell"

const DEFAULT_TIMEOUT = 2 * 60 * 1000
const MAX_TIMEOUT = 10 * 60 * 1000

/** Split a command line on `&&`, `||`, `;`, `|` and newlines that sit outside quotes. */
export function splitCommands(command: string): string[] {
  const parts: string[] = []
  let current = ""
  let quote = ""
  let depth = 0
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    const next = command[i + 1]
    if (quote) {
      current += ch
      if (ch === "\\" && quote === '"' && next !== undefined) {
        current += next
        i++
      } else if (ch === quote) quote = ""
      continue
    }
    if (ch === "\\" && next !== undefined) {
      current += ch + next
      i++
      continue
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch
      current += ch
      continue
    }
    if (ch === "(" || ch === "{") depth++
    if (ch === ")" || ch === "}") depth = Math.max(0, depth - 1)
    if (depth === 0) {
      if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
        parts.push(current)
        current = ""
        i++
        continue
      }
      if (ch === ";" || ch === "|" || ch === "\n" || (ch === "&" && next !== ">")) {
        parts.push(current)
        current = ""
        continue
      }
    }
    current += ch
  }
  parts.push(current)
  return parts.map((p) => p.trim()).filter((p) => p !== "")
}

/** "git commit -m x" → "git commit *": the pattern remembered when the user answers "always". */
export function commandPrefix(command: string): string {
  const words = command.split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w))
  const head = words[0] ?? command
  const sub = words[1]
  const withSub = new Set(["git", "npm", "pnpm", "yarn", "bun", "npx", "cargo", "go", "docker", "kubectl", "pip", "pip3", "uv", "gh", "make", "dotnet", "brew", "apt", "apt-get"])
  if (sub && withSub.has(head) && !sub.startsWith("-")) return `${head} ${sub} *`
  return `${head} *`
}

export const BashTool = defineTool<{ command: string; timeout?: number; workdir?: string; description?: string }>({
  id: "bash",
  get description() {
    const shell = detectShell()
    const windows = process.platform === "win32"
    return `Executes a command in a ${shell.name} shell and returns its combined stdout and stderr.

Environment: ${windows ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux"}, shell: ${shell.name}.${
      shell.name === "pwsh" || shell.name === "powershell"
        ? " Write PowerShell syntax (Get-ChildItem, Select-String, $env:NAME, `;` to chain). Unix utilities such as grep, sed or cat may be unavailable."
        : shell.name === "cmd"
          ? " Write cmd.exe syntax."
          : windows
            ? " This is Git Bash: use POSIX syntax and forward slashes."
            : ""
    }

Usage:
- Each call starts a fresh shell in the working directory: state such as \`cd\` or exported variables does not persist. Use the workdir parameter instead of \`cd\`.
- Quote paths that contain spaces.
- Commands time out after ${DEFAULT_TIMEOUT / 1000} seconds unless you pass timeout (milliseconds, max ${MAX_TIMEOUT}).
- Output beyond 2000 lines or 50KB is truncated; filter noisy commands.
- Never run interactive commands that wait for input (editors, REPLs, \`git rebase -i\`, prompts). Pass flags such as -y or --no-edit.
- Prefer the dedicated tools over shell equivalents: read (not cat/head/tail), grep (not grep/rg), glob (not find/ls), edit and write (not sed/echo redirection).
- Independent commands can be issued as parallel tool calls; chain dependent ones with ${shell.name === "powershell" ? ";" : "&&"}.
- Only commit, push or run destructive commands when the user asked for it.`
  },
  parameters: {
    type: "object",
    required: ["command"],
    properties: {
      command: { type: "string", description: "The command to execute" },
      timeout: { type: "number", description: "Timeout in milliseconds" },
      workdir: { type: "string", description: "Directory to run in (defaults to the working directory)" },
      description: { type: "string", description: "What this command does, in 5-10 words" },
    },
  },
  async execute(args, ctx) {
    const cwd = args.workdir ? resolvePath(ctx, args.workdir) : ctx.directory
    if (args.workdir) await assertInsideProject(ctx, cwd, "directory")
    const timeout = Math.min(Math.max(1000, args.timeout ?? DEFAULT_TIMEOUT), MAX_TIMEOUT)
    const commands = splitCommands(args.command)
    // A prefix allow-rule must never authorize nested shell execution or file redirection.
    // Literal matches can ask unnecessarily, which is safer than guessing shell grammar.
    if (/\$\(|`|[<>]|(?:^|\s)(?:--output|--ext-diff|--textconv)(?:[=\s]|$)/.test(args.command)) commands.push("[shell expansion or redirection]")
    await ctx.ask({
      permission: "bash",
      patterns: commands.length ? commands : [args.command],
      always: [...new Set((commands.length ? commands : [args.command]).map(commandPrefix))],
      title: args.command,
      metadata: { command: args.command, description: args.description, cwd },
    })

    const shell = detectShell()
    let script = args.command
    if (shell.name === "pwsh" || shell.name === "powershell") {
      // UTF-8 output, and propagate the exit code of the last native command.
      script = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${args.command}\nif ($LASTEXITCODE) { exit $LASTEXITCODE }`
    }

    const title = args.description || args.command
    const child = spawn(shell.path, [...shell.args, script], {
      cwd,
      env: { ...process.env, TERM: "dumb", NO_COLOR: "1", FORCE_COLOR: "0", GIT_PAGER: "cat", PAGER: "cat", GIT_TERMINAL_PROMPT: "0", CI: process.env.CI ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // own process group so the whole tree can be signalled
      detached: process.platform !== "win32",
    })

    let output = ""
    let lastPush = 0
    const push = (force = false) => {
      const now = Date.now()
      if (!force && now - lastPush < 150) return
      lastPush = now
      ctx.metadata({ title, metadata: { output: output.length > 30_000 ? output.slice(-30_000) : output, description: args.description } })
    }
    const onData = (chunk: Buffer) => {
      // keep memory bounded on runaway commands; the tail is what matters
      if (output.length < 5_000_000) output += chunk.toString()
      push()
    }
    child.stdout?.on("data", onData)
    child.stderr?.on("data", onData)

    let timedOut = false
    let aborted = false
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child.pid)
    }, timeout)
    const onAbort = () => {
      aborted = true
      killTree(child.pid)
    }
    if (ctx.abort.aborted) onAbort()
    ctx.abort.addEventListener("abort", onAbort, { once: true })

    const exit = await new Promise<number | null>((resolve) => {
      child.on("error", (err) => {
        output += `\n${err.message}`
        resolve(-1)
      })
      child.on("close", (code) => resolve(code))
    })
    clearTimeout(timer)
    ctx.abort.removeEventListener("abort", onAbort)

    const truncated = truncateOutput(output.replace(/\r\n/g, "\n"), { direction: "tail" })
    let result = truncated.content.trimEnd()
    const notes: string[] = []
    if (timedOut) notes.push(`The command was terminated after exceeding the timeout of ${timeout} ms.`)
    if (aborted) notes.push("The command was interrupted by the user.")
    if (!timedOut && !aborted && exit !== 0 && exit !== null) notes.push(`Exit code: ${exit}`)
    if (notes.length) result += `${result ? "\n\n" : ""}<bash_metadata>\n${notes.join("\n")}\n</bash_metadata>`
    if (result === "") result = "(no output)"

    return {
      title,
      output: result,
      metadata: { output: truncated.content, exit, description: args.description, truncated: truncated.truncated, cwd: path.relative(ctx.worktree, cwd) || "." },
    }
  },
})
