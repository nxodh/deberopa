import fs from "node:fs"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"

export interface ShellInfo {
  /** Executable to spawn. */
  path: string
  /** Short name for prompts: "bash", "zsh", "pwsh", "powershell", "cmd". */
  name: string
  /** Arguments that precede the command string. */
  args: string[]
}

function onPath(name: string): string | undefined {
  const exts = process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""]
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext)
      try {
        if (fs.statSync(candidate).isFile()) return candidate
      } catch {}
    }
  }
  return undefined
}

let cached: ShellInfo | undefined

/**
 * The shell commands run in. POSIX: the user's shell when it is bash/zsh, else bash, else sh.
 * Windows: Git Bash when installed (models write far better bash than PowerShell), then
 * PowerShell 7, then Windows PowerShell, with cmd.exe as the last resort.
 */
export function detectShell(): ShellInfo {
  if (cached) return cached
  const override = process.env.VEDECAPS_SHELL
  if (override) {
    const name = path.basename(override).replace(/\.exe$/i, "").toLowerCase()
    return (cached = { path: override, name, args: shellArgs(name) })
  }
  if (process.platform === "win32") {
    const gitBash = [
      process.env.VEDECAPS_GIT_BASH_PATH,
      path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe"),
      path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Git", "bin", "bash.exe"),
      path.join(process.env.LOCALAPPDATA || "", "Programs", "Git", "bin", "bash.exe"),
    ].find((p) => p && fs.existsSync(p))
    if (gitBash) return (cached = { path: gitBash, name: "bash", args: ["-c"] })
    const pwsh = onPath("pwsh")
    if (pwsh) return (cached = { path: pwsh, name: "pwsh", args: shellArgs("pwsh") })
    const powershell = onPath("powershell")
    if (powershell) return (cached = { path: powershell, name: "powershell", args: shellArgs("powershell") })
    return (cached = { path: process.env.ComSpec || "cmd.exe", name: "cmd", args: ["/d", "/s", "/c"] })
  }
  const user = process.env.SHELL
  if (user && /(bash|zsh)$/.test(user) && fs.existsSync(user)) {
    return (cached = { path: user, name: path.basename(user), args: ["-c"] })
  }
  const bash = onPath("bash")
  if (bash) return (cached = { path: bash, name: "bash", args: ["-c"] })
  return (cached = { path: "/bin/sh", name: "sh", args: ["-c"] })
}

function shellArgs(name: string): string[] {
  if (name === "pwsh" || name === "powershell") return ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]
  if (name === "cmd") return ["/d", "/s", "/c"]
  return ["-c"]
}

/** Kill a process and everything it started. */
export function killTree(pid: number | undefined) {
  if (!pid) return
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(pid), "/f", "/t"], { stdio: "ignore", windowsHide: true })
    } catch {}
    return
  }
  try {
    process.kill(-pid, "SIGTERM")
  } catch {
    try {
      process.kill(pid, "SIGTERM")
    } catch {}
  }
  const timer = setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL")
    } catch {}
  }, 2000)
  timer.unref?.()
}

export interface RunResult {
  stdout: string
  stderr: string
  code: number | null
}

/** Run a program to completion and capture its output. Never throws; a spawn failure yields code -1. */
export function run(command: string, args: string[], opts: { cwd?: string; env?: Record<string, string | undefined>; timeout?: number; input?: string } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = ""
    let stderr = ""
    let done = false
    const finish = (code: number | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ stdout, stderr, code })
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
    } catch (err) {
      resolve({ stdout: "", stderr: String(err), code: -1 })
      return
    }
    const timer = setTimeout(() => {
      killTree(child.pid)
      finish(-1)
    }, opts.timeout ?? 30_000)
    child.stdout?.on("data", (d) => (stdout += d.toString()))
    child.stderr?.on("data", (d) => (stderr += d.toString()))
    child.on("error", (err) => {
      stderr += String(err)
      finish(-1)
    })
    child.on("close", (code) => finish(code))
    if (opts.input !== undefined) child.stdin?.write(opts.input)
    child.stdin?.end()
  })
}

/**
 * How to start a child process on this platform. Batch shims (npx.cmd and friends) only run
 * through cmd.exe, and PATH lookup needs PATHEXT, so bare names are resolved on Windows and
 * shims get a hand-built, fully quoted command line (use with `windowsVerbatimArguments`).
 */
export function launchSpec(command: string[]): { file: string; args: string[]; verbatim: boolean } {
  const [exe = "", ...args] = command
  if (process.platform !== "win32") return { file: exe, args, verbatim: false }
  const file = path.extname(exe) ? exe : (onPath(exe) ?? exe)
  if (/\.(cmd|bat)$/i.test(file)) {
    const line = [file, ...args].map((arg) => `"${arg.replace(/"/g, '""')}"`).join(" ")
    return { file: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], verbatim: true }
  }
  return { file, args, verbatim: false }
}

export { onPath as which }
