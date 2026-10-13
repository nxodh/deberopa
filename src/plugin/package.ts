import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { Paths } from "../global"
import { run, which, type RunResult } from "../util/shell"
import { isInside } from "../util/fs"
import { redact } from "../util/redact"

export function parsePackage(input: string): { name: string; version: string; spec: string } {
  const spec = input.replace(/^npm:/, "")
  const match = /^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)@(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)$/.exec(spec)
  if (!match) throw new Error("Use an npm package with an exact version: name@1.2.3 or @scope/name@1.2.3. URLs, tags and version ranges are not accepted.")
  return { name: match[1]!, version: match[2]!, spec }
}

export function packageDir(spec: string): string {
  const parsed = parsePackage(spec)
  return path.join(Paths.data, "plugins", createHash("sha256").update(parsed.spec).digest("hex"))
}

export async function packageEntry(input: string): Promise<string> {
  const { name, version, spec } = parsePackage(input)
  const dir = packageDir(spec)
  const manifest = JSON.parse(await fs.readFile(path.join(dir, "node_modules", ...name.split("/"), "package.json"), "utf8").catch(() => {
    throw new Error(`Plugin ${spec} is not installed. Run \`vedecaps plugin install ${spec}\`.`)
  }))
  if (manifest.name !== name || manifest.version !== version) throw new Error(`Plugin ${spec} has an unexpected package identity`)
  await fs.access(path.join(dir, "package-lock.json"))
  const entry = await fs.realpath(Bun.resolveSync(name, dir))
  if (!isInside(await fs.realpath(dir), entry)) throw new Error("The plugin entry points outside its installation directory")
  return entry
}

export async function installPackage(input: string, runner?: (command: string[]) => Promise<RunResult>): Promise<string> {
  const { spec } = parsePackage(input)
  const dir = packageDir(spec)
  const npm = which("npm")
  if (!runner && !npm) throw new Error("npm is required to install package plugins. Loading an installed plugin needs only Vedecaps.")
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "vedecaps-plugins", private: true }))
  const command = [npm ?? "npm", "install", "--prefix", dir, "--ignore-scripts", "--save-exact", "--package-lock=true", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org/", spec]
  const result = runner ? await runner(command) : await run(command[0]!, command.slice(1), { cwd: dir, timeout: 5 * 60_000 })
  if (result.code !== 0) throw new Error(`Plugin install failed: ${redact(result.stderr || result.stdout).slice(-1500)}`)
  return packageEntry(spec)
}
