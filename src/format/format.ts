import fs from "node:fs/promises"
import path from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { getConfig, type FormatterConfig } from "../config/config"
import { project } from "../project"
import { exists, findUp, readJSON } from "../util/fs"
import { createLogger } from "../util/log"
import { killTree, run, which, type RunResult } from "../util/shell"

const log = createLogger("format")
const WIN = process.platform === "win32"
const TIMEOUT_MS = 15_000

export interface FormatterInfo {
  name: string
  /** With leading dot, lower-case. */
  extensions: string[]
  /** "$FILE" is replaced by the absolute file path. */
  command: string[]
  environment?: Record<string, string>
  /** Whether this formatter should be used for the current project. */
  enabled(ctx: { directory: string; worktree: string }): Promise<boolean>
}

type Ctx = { directory: string; worktree: string }

/** Project-local node_modules/.bin wins over PATH, as with npx. */
async function findBinary(name: string, ctx: Ctx): Promise<string | undefined> {
  if (path.isAbsolute(name) || /[\\/]/.test(name)) {
    const abs = path.resolve(ctx.directory, name)
    return (await exists(abs)) ? abs : undefined
  }
  const shim = WIN ? `${name}.cmd` : name
  const [local] = await findUp([path.join("node_modules", ".bin", shim)], ctx.directory, ctx.worktree)
  return local ?? which(name)
}

async function hasBinary(name: string, ctx: Ctx): Promise<boolean> {
  return (await findBinary(name, ctx)) !== undefined
}

async function hasUp(names: string[], ctx: Ctx): Promise<boolean> {
  return (await findUp(names, ctx.directory, ctx.worktree)).length > 0
}

/** Some file named in `names` found walking up contains `needle`. */
async function upFileContains(names: string[], needle: string, ctx: Ctx): Promise<boolean> {
  for (const file of await findUp(names, ctx.directory, ctx.worktree)) {
    try {
      if ((await fs.readFile(file, "utf8")).includes(needle)) return true
    } catch {
      // unreadable counts as absent
    }
  }
  return false
}

/** Some package.json found walking up lists `dep`. */
async function packageLists(dep: string, ctx: Ctx): Promise<boolean> {
  for (const file of await findUp(["package.json"], ctx.directory, ctx.worktree)) {
    const pkg = await readJSON<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(file)
    if (pkg?.dependencies?.[dep] !== undefined || pkg?.devDependencies?.[dep] !== undefined) return true
  }
  return false
}

const normExt = (ext: string) => (ext.startsWith(".") ? ext : `.${ext}`).toLowerCase()

// Order matters: the first enabled formatter for an extension wins (biome before prettier, ruff before black).
export const BUILTIN_FORMATTERS: FormatterInfo[] = [
  {
    name: "biome",
    extensions: [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".json", ".jsonc", ".css"],
    command: ["biome", "format", "--write", "$FILE"],
    enabled: async (ctx) => (await hasUp(["biome.json", "biome.jsonc"], ctx)) && (await hasBinary("biome", ctx)),
  },
  {
    name: "prettier",
    extensions: [
      ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".html", ".htm", ".css", ".scss", ".sass", ".less",
      ".vue", ".svelte", ".json", ".jsonc", ".yaml", ".yml", ".toml", ".xml", ".md", ".mdx", ".graphql", ".gql",
    ],
    command: ["prettier", "--write", "$FILE"],
    enabled: async (ctx) => (await packageLists("prettier", ctx)) && (await hasBinary("prettier", ctx)),
  },
  {
    name: "gofmt",
    extensions: [".go"],
    command: ["gofmt", "-w", "$FILE"],
    enabled: (ctx) => hasBinary("gofmt", ctx),
  },
  {
    name: "rustfmt",
    extensions: [".rs"],
    command: ["rustfmt", "$FILE"],
    enabled: (ctx) => hasBinary("rustfmt", ctx),
  },
  {
    name: "ruff",
    extensions: [".py", ".pyi"],
    command: ["ruff", "format", "$FILE"],
    enabled: async (ctx) =>
      (await hasBinary("ruff", ctx)) &&
      ((await hasUp(["ruff.toml", ".ruff.toml"], ctx)) || (await upFileContains(["pyproject.toml"], "[tool.ruff", ctx))),
  },
  {
    name: "black",
    extensions: [".py", ".pyi"],
    command: ["black", "-q", "$FILE"],
    enabled: async (ctx) => (await hasBinary("black", ctx)) && (await upFileContains(["pyproject.toml"], "[tool.black", ctx)),
  },
  {
    name: "clang-format",
    extensions: [".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx", ".ino"],
    command: ["clang-format", "-i", "$FILE"],
    enabled: async (ctx) => (await hasBinary("clang-format", ctx)) && (await hasUp([".clang-format"], ctx)),
  },
  {
    name: "zig",
    extensions: [".zig", ".zon"],
    command: ["zig", "fmt", "$FILE"],
    enabled: (ctx) => hasBinary("zig", ctx),
  },
  {
    name: "dart",
    extensions: [".dart"],
    command: ["dart", "format", "$FILE"],
    enabled: (ctx) => hasBinary("dart", ctx),
  },
  {
    name: "mix",
    extensions: [".ex", ".exs", ".eex", ".heex"],
    command: ["mix", "format", "$FILE"],
    enabled: (ctx) => hasBinary("mix", ctx),
  },
  {
    name: "terraform",
    extensions: [".tf", ".tfvars"],
    command: ["terraform", "fmt", "$FILE"],
    enabled: (ctx) => hasBinary("terraform", ctx),
  },
  {
    name: "shfmt",
    extensions: [".sh", ".bash"],
    command: ["shfmt", "-w", "$FILE"],
    enabled: (ctx) => hasBinary("shfmt", ctx),
  },
  {
    name: "stylua",
    extensions: [".lua"],
    command: ["stylua", "$FILE"],
    enabled: async (ctx) => (await hasBinary("stylua", ctx)) && (await hasUp(["stylua.toml", ".stylua.toml"], ctx)),
  },
  {
    name: "ktlint",
    extensions: [".kt", ".kts"],
    command: ["ktlint", "-F", "$FILE"],
    enabled: (ctx) => hasBinary("ktlint", ctx),
  },
]

const BUILTIN_NAMES = new Set(BUILTIN_FORMATTERS.map((f) => f.name))

interface Resolved {
  info: FormatterInfo
  /** Turned off by config; kept so status output can show it. */
  disabled: boolean
}

/** Merges config over the built-ins by name, then appends custom formatters. */
function resolveFormatters(cfg: Record<string, FormatterConfig>): Resolved[] {
  const out: Resolved[] = []
  for (const base of BUILTIN_FORMATTERS) {
    const over = cfg[base.name]
    out.push({
      disabled: over?.disabled === true,
      info: {
        ...base,
        command: over?.command?.length ? over.command : base.command,
        extensions: over?.extensions?.length ? over.extensions.map(normExt) : base.extensions,
        environment: over?.environment ?? base.environment,
      },
    })
  }
  for (const [name, entry] of Object.entries(cfg)) {
    if (BUILTIN_NAMES.has(name) || entry.disabled === true) continue
    if (!entry.command?.length || !entry.extensions?.length) {
      log.warn(`formatter "${name}" needs both command and extensions; ignored`)
      continue
    }
    out.push({
      disabled: false,
      info: {
        name,
        command: entry.command,
        extensions: entry.extensions.map(normExt),
        environment: entry.environment,
        enabled: async () => true,
      },
    })
  }
  return out
}

// Cached per process as promises so concurrent edits share one check.
const enabledCache = new Map<string, Promise<boolean>>()

function isEnabled(info: FormatterInfo, ctx: Ctx): Promise<boolean> {
  let result = enabledCache.get(info.name)
  if (!result) {
    result = Promise.resolve()
      .then(() => info.enabled(ctx))
      .catch((err) => {
        log.warn(`enabled check for ${info.name} failed`, err)
        return false
      })
    enabledCache.set(info.name, result)
  }
  return result
}

/**
 * Node cannot spawn .cmd/.bat directly, and run() re-quotes arguments in a way cmd.exe cannot
 * read back, so batch shims get a hand-built command line.
 */
function execute(bin: string, args: string[], opts: { cwd: string; env?: Record<string, string | undefined>; timeout: number }): Promise<RunResult> {
  if (!(WIN && /\.(cmd|bat)$/i.test(bin))) return run(bin, args, opts)
  const line = [`"${bin}"`, ...args.map((a) => `"${a}"`)].join(" ")
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
    let child: ChildProcess
    try {
      child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        windowsHide: true,
        windowsVerbatimArguments: true,
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (err) {
      resolve({ stdout: "", stderr: String(err), code: -1 })
      return
    }
    const timer = setTimeout(() => {
      killTree(child.pid)
      finish(-1)
    }, opts.timeout)
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString()
    })
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString()
    })
    child.on("error", (err) => {
      stderr += String(err)
      finish(-1)
    })
    child.on("close", (code) => finish(code))
  })
}

const tail = (s: string) => s.trim().slice(-500)

async function runFormatter(info: FormatterInfo, abs: string, ctx: Ctx): Promise<string | undefined> {
  const [program, ...args] = info.command.map((part) => part.replaceAll("$FILE", abs))
  if (!program) return undefined
  const bin = (await findBinary(program, ctx)) ?? program
  const result = await execute(bin, args, { cwd: ctx.directory, env: info.environment, timeout: TIMEOUT_MS })
  if (result.code !== 0) {
    log.warn(`${info.name} exited with ${result.code} on ${abs}`, tail(result.stderr || result.stdout))
    return undefined
  }
  return info.name
}

/** Formats `file` in place. Returns the formatter name used, or undefined when none applied. Never throws. */
export async function formatFile(file: string): Promise<string | undefined> {
  try {
    const config = await getConfig()
    if (config.formatter === false) return undefined
    const cfg: Record<string, FormatterConfig> = config.formatter || {}
    const ctx = project()
    const ext = path.extname(file).toLowerCase()
    for (const { info, disabled } of resolveFormatters(cfg)) {
      if (disabled || !info.extensions.includes(ext)) continue
      if (!(await isEnabled(info, ctx))) continue
      return await runFormatter(info, path.resolve(file), ctx)
    }
    return undefined
  } catch (err) {
    log.warn(`formatting ${file} failed`, err)
    return undefined
  }
}

/** For `vedecaps debug`/status output: every formatter with whether it is active here. */
export async function formatterStatus(): Promise<Array<{ name: string; extensions: string[]; enabled: boolean }>> {
  const config = await getConfig()
  const cfg: Record<string, FormatterConfig> = config.formatter || {}
  const off = config.formatter === false
  const ctx = project()
  const out: Array<{ name: string; extensions: string[]; enabled: boolean }> = []
  for (const { info, disabled } of resolveFormatters(cfg)) {
    const enabled = !off && !disabled && (await isEnabled(info, ctx))
    out.push({ name: info.name, extensions: info.extensions, enabled })
  }
  return out
}

export function resetFormatters(): void {
  enabledCache.clear()
}
