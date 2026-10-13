import fs from "node:fs/promises"
import path from "node:path"
import { gunzipSync } from "node:zlib"
import { spawn } from "node:child_process"
import { Paths, VERSION } from "../global"
import { createLogger } from "../util/log"
import { launchSpec, which } from "../util/shell"

const log = createLogger("lsp-install")

/**
 * Language servers Vedecaps can fetch itself, always into its own data directory (never a
 * global install), and only after the user said yes. Servers not listed here (clangd, zls,
 * ruby-lsp, lua-language-server) have to be installed by the user.
 */
export interface Installer {
  id: string
  /** Name shown in the confirmation. */
  label: string
  /** What will happen, in one line, for the confirmation. */
  how: string
  /** Program that must already exist for this installer to work. */
  requires?: string
  /** Rough download size for the confirmation. */
  size: string
  /** Path of the launcher inside the install directory, plus its arguments. */
  command(dir: string): string[]
  install(dir: string, say: (message: string) => void, signal?: AbortSignal): Promise<void>
}

const exe = (name: string) => (process.platform === "win32" ? `${name}.exe` : name)
const cmd = (name: string) => (process.platform === "win32" ? `${name}.cmd` : name)

export const installDir = (id: string) => path.join(Paths.data, "lsp", id)

function exec(command: string[], opts: { cwd?: string; env?: Record<string, string>; timeoutMs: number; signal?: AbortSignal }): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const spec = launchSpec(command)
    let output = ""
    const child = spawn(spec.file, spec.args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env, npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false" },
      windowsHide: true,
      windowsVerbatimArguments: spec.verbatim,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const timer = setTimeout(() => child.kill(), opts.timeoutMs)
    const abort = () => child.kill()
    opts.signal?.addEventListener("abort", abort, { once: true })
    child.stdout?.on("data", (d) => (output += d.toString()))
    child.stderr?.on("data", (d) => (output += d.toString()))
    const done = (code: number | null) => {
      clearTimeout(timer)
      opts.signal?.removeEventListener("abort", abort)
      resolve({ code, output: output.slice(-1500) })
    }
    child.on("error", (err) => {
      output += String(err)
      done(-1)
    })
    child.on("close", done)
  })
}

async function npmInstall(dir: string, packages: string[], signal?: AbortSignal) {
  const npm = which("npm")
  if (!npm) throw new Error("npm was not found on PATH")
  await fs.mkdir(dir, { recursive: true })
  // a package.json of its own keeps npm from walking up into the user's project
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "vedecaps-lsp", private: true }))
  const result = await exec([npm, "install", "--prefix", dir, "--no-save", "--ignore-scripts", ...packages], { timeoutMs: 5 * 60_000, signal })
  if (result.code !== 0) throw new Error(`npm install failed:\n${result.output.trim()}`)
}

function rustAnalyzerAsset(): { name: string; zip: boolean } {
  const { platform, arch } = process
  const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : undefined
  if (!cpu) throw new Error(`no rust-analyzer build for ${arch}`)
  if (platform === "darwin") return { name: `rust-analyzer-${cpu}-apple-darwin.gz`, zip: false }
  if (platform === "linux") return { name: `rust-analyzer-${cpu}-unknown-linux-gnu.gz`, zip: false }
  if (platform === "win32") return { name: `rust-analyzer-${cpu}-pc-windows-msvc.zip`, zip: true }
  throw new Error(`no rust-analyzer build for ${platform}`)
}

export const INSTALLERS: Installer[] = [
  {
    id: "typescript",
    label: "TypeScript language server",
    how: "npm install typescript-language-server and typescript",
    requires: "npm",
    size: "about 15 MB",
    command: (dir) => [path.join(dir, "node_modules", ".bin", cmd("typescript-language-server")), "--stdio"],
    // typescript 6+ ships the native compiler, which has no lib/tsserver.js for the language server to drive
    install: (dir, _say, signal) => npmInstall(dir, ["typescript-language-server", "typescript@5"], signal),
  },
  {
    id: "pyright",
    label: "Pyright (Python language server)",
    how: "npm install pyright",
    requires: "npm",
    size: "about 10 MB",
    command: (dir) => [path.join(dir, "node_modules", ".bin", cmd("pyright-langserver")), "--stdio"],
    install: (dir, _say, signal) => npmInstall(dir, ["pyright"], signal),
  },
  {
    id: "gopls",
    label: "gopls (Go language server)",
    how: "go install golang.org/x/tools/gopls@latest",
    requires: "go",
    size: "about 30 MB",
    command: (dir) => [path.join(dir, "bin", exe("gopls"))],
    async install(dir, _say, signal) {
      const go = which("go")
      if (!go) throw new Error("go was not found on PATH")
      await fs.mkdir(path.join(dir, "bin"), { recursive: true })
      const result = await exec([go, "install", "golang.org/x/tools/gopls@latest"], { env: { GOBIN: path.join(dir, "bin") }, timeoutMs: 8 * 60_000, signal })
      if (result.code !== 0) throw new Error(`go install failed:\n${result.output.trim()}`)
    },
  },
  {
    id: "rust-analyzer",
    label: "rust-analyzer",
    how: "download the official release from github.com/rust-lang/rust-analyzer",
    size: "about 15 MB",
    command: (dir) => [path.join(dir, "bin", exe("rust-analyzer"))],
    async install(dir, _say, signal) {
      const asset = rustAnalyzerAsset()
      const res = await fetch(`https://github.com/rust-lang/rust-analyzer/releases/latest/download/${asset.name}`, {
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)]) : AbortSignal.timeout(5 * 60_000),
        headers: { "User-Agent": `vedecaps/${VERSION}` },
      })
      if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`)
      const data = Buffer.from(await res.arrayBuffer())
      const bin = path.join(dir, "bin")
      await fs.mkdir(bin, { recursive: true })
      const target = path.join(bin, exe("rust-analyzer"))
      if (asset.zip) {
        const archive = path.join(dir, asset.name)
        await fs.writeFile(archive, data)
        const result = await exec(["tar", "-xf", archive, "-C", bin], { timeoutMs: 60_000, signal })
        await fs.rm(archive, { force: true })
        if (result.code !== 0) throw new Error(`could not unpack the download:\n${result.output.trim()}`)
      } else {
        await fs.writeFile(target, gunzipSync(data), { mode: 0o755 })
      }
      await fs.chmod(target, 0o755).catch(() => {})
    },
  },
]

export function installerFor(id: string): Installer | undefined {
  return INSTALLERS.find((i) => i.id === id)
}

/** Launch command of an already-installed server, or undefined. */
export async function installedCommand(id: string): Promise<string[] | undefined> {
  const installer = installerFor(id)
  if (!installer) return undefined
  const command = installer.command(installDir(id))
  return (await fs.stat(command[0]!).then(() => true, () => false)) ? command : undefined
}

export async function runInstaller(id: string, say: (message: string) => void, signal?: AbortSignal): Promise<string[]> {
  const installer = installerFor(id)
  if (!installer) throw new Error(`no installer for ${id}`)
  if (installer.requires && !which(installer.requires)) throw new Error(`${installer.requires} is required to install the ${installer.label} but was not found on PATH`)
  const dir = installDir(id)
  say(`Installing the ${installer.label}…`)
  log.info(`installing ${id} into ${dir}`)
  await installer.install(dir, say, signal)
  const command = await installedCommand(id)
  if (!command) throw new Error("the installer finished but the server executable was not created")
  log.info(`installed ${id}`)
  return command
}
