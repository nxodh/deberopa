import { parse, type CommandSpec, UsageError } from "../args"
import { ask } from "../input"
import { bootstrap } from "../bootstrap"
import { globalConfigFile, updateGlobalConfig } from "../../config/config"
import { installPackage, parsePackage } from "../../plugin/package"
import { loadPlugins, pluginProblems } from "../../plugin"
import { redact } from "../../util/redact"

export const spec: CommandSpec = {
  usage: "vedecaps plugin <list|install|remove> [package@version]",
  description: "manage explicitly installed npm plugins (full user privileges)",
  options: { yes: { type: "boolean", short: "y", description: "confirm that this package may execute as you" } },
  examples: ["vedecaps plugin install @scope/plugin@1.2.3", "vedecaps plugin list"],
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, spec.options!)
  await bootstrap()
  const [action, input] = positionals
  if (action === "list") {
    for (const p of await loadPlugins()) process.stdout.write(redact(`${p.name} (${p.source})\n`))
    for (const p of pluginProblems()) process.stdout.write(redact(`FAILED ${p.file}: ${p.error}\n`))
    return 0
  }
  if (!input || !["install", "remove"].includes(action ?? "")) throw new UsageError(spec.usage!)
  const parsed = parsePackage(input)
  const entry = "npm:" + parsed.spec
  if (action === "install") {
    if (!values.yes && (!process.stdin.isTTY || (await ask(`Install ${parsed.spec}? It runs code with your full permissions. npm lifecycle scripts are disabled. Type yes: `)).trim() !== "yes")) {
      throw new UsageError("Installation was not confirmed. Review the package, then use --yes in non-interactive mode.")
    }
    await installPackage(parsed.spec)
  }
  // Only change the user's global list, never promote a repository's plugins to global ones.
  const fs = await import("node:fs/promises")
  const { parse: jsonc } = await import("jsonc-parser")
  const text = await fs.readFile(globalConfigFile(), "utf8").catch(() => "{}")
  const config = jsonc(text)
  const current: string[] = Array.isArray(config?.plugin) ? config.plugin : []
  const plugin = current.filter((p) => p !== entry)
  if (action === "install") plugin.push(entry)
  await updateGlobalConfig({ plugin })
  process.stdout.write(`${action === "install" ? "Installed and enabled" : "Disabled"} ${parsed.spec}\n`)
  return 0
}
