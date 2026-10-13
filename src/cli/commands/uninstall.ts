import fs from "node:fs/promises"
import path from "node:path"
import { Paths } from "../../global"
import { parse, type CommandSpec } from "../args"
import { ask } from "../input"
import { isCompiled } from "../../update/update"

export const spec: CommandSpec = {
  usage: "vedecaps uninstall [options]",
  description: "remove vedecaps and (optionally) its data from this machine",
  options: {
    "keep-config": { type: "boolean", description: "keep configuration files" },
    "keep-data": { type: "boolean", description: "keep sessions, credentials and snapshots" },
    "dry-run": { type: "boolean", description: "show what would be removed without removing anything" },
    yes: { type: "boolean", short: "y", description: "do not ask for confirmation" },
  },
}

export async function main(argv: string[]): Promise<number> {
  const { values } = parse(argv, spec.options!)
  const targets: { label: string; path: string }[] = []
  if (!values["keep-data"]) {
    targets.push({ label: "sessions, credentials, snapshots, logs", path: Paths.data })
    targets.push({ label: "cache", path: Paths.cache })
    targets.push({ label: "state", path: Paths.state })
  }
  if (!values["keep-config"]) targets.push({ label: "configuration", path: Paths.config })
  const binary = isCompiled() ? process.execPath : undefined
  if (binary) targets.push({ label: "executable", path: binary })

  const existing: typeof targets = []
  for (const target of targets) {
    if (await fs.stat(target.path).then(() => true, () => false)) existing.push(target)
  }
  if (existing.length === 0) {
    process.stdout.write("Nothing to remove.\n")
    return 0
  }
  process.stdout.write("This will remove:\n" + existing.map((t) => `  ${t.path}  (${t.label})`).join("\n") + "\n")
  if (values["dry-run"]) return 0
  if (!values.yes) {
    if (!process.stdin.isTTY) {
      process.stderr.write("Refusing to uninstall without confirmation. Pass --yes to proceed.\n")
      return 1
    }
    const answer = await ask("Continue? [y/N] ")
    if (!/^y(es)?$/i.test(answer)) {
      process.stdout.write("Cancelled.\n")
      return 1
    }
  }

  for (const target of existing) {
    try {
      if (target.path === binary && process.platform === "win32") {
        // The running exe cannot delete itself on Windows; move it aside for the OS to clean up.
        await fs.rename(binary, `${binary}.old`)
        process.stdout.write(`Renamed ${binary} to ${path.basename(binary)}.old (delete it after this command exits)\n`)
      } else {
        await fs.rm(target.path, { recursive: true, force: true })
        process.stdout.write(`Removed ${target.path}\n`)
      }
    } catch (err) {
      process.stderr.write(`Could not remove ${target.path}: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }
  if (binary) {
    const dir = path.dirname(binary)
    await fs.rmdir(dir).catch(() => {}) // only succeeds when the bin directory is now empty
    process.stdout.write(`\nIf ${dir} was added to your PATH, remove that line from your shell profile.\n`)
  }
  return 0
}
