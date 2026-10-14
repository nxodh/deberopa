import os from "node:os"
import { Paths, VERSION } from "../../global"
import { project } from "../../project"
import { loadConfig } from "../../config/config"
import { allProviders } from "../../provider/provider"
import { formatterStatus } from "../../format/format"
import { BUILTIN_SERVERS, resolveServer } from "../../lsp"
import { installerFor } from "../../lsp/install"
import { detectShell, which } from "../../util/shell"
import { listAgents } from "../../agent/agent"
import { listSkills } from "../../skill/skill"
import { listCommands } from "../../command/command"
import { startMcp, mcpStatus } from "../../mcp"
import { redactDeep } from "../../util/redact"
import { parse, type CommandSpec } from "../args"
import { bootstrap } from "../bootstrap"

export const spec: CommandSpec = {
  usage: "vedecaps debug [config|local] [options]",
  description: "show paths, loaded config, providers and tooling (useful for bug reports)",
  options: {
    "check-tools": { type: "boolean", description: "with `local`: send one request per server to test tool calling (generates tokens)" },
    help: { type: "boolean", short: "h", description: "show this help" },
  },
  examples: ["vedecaps debug", "vedecaps debug local", "vedecaps debug local --check-tools"],
}

export async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parse(argv, spec.options!)
  await bootstrap()
  const out = (s = "") => process.stdout.write(s + "\n")
  const loaded = await loadConfig()
  if (positionals[0] === "config") {
    out(JSON.stringify(redactDeep(loaded.config), null, 2))
    return 0
  }
  if (positionals[0] === "local") {
    const { runLocalDebug } = await import("./local-debug")
    const { allProviders } = await import("../../provider/provider")
    return runLocalDebug({ checkTools: values["check-tools"] === true, providers: Object.values(await allProviders()), out })
  }
  const p = project()
  out(`vedecaps ${VERSION}`)
  out(`${process.platform} ${process.arch} · ${os.release()} · runtime ${typeof Bun !== "undefined" ? `bun ${Bun.version}` : `node ${process.version}`}`)
  out(`shell      ${detectShell().path} (${detectShell().name})`)
  out(`git        ${which("git") ?? "not found"}`)
  out()
  out("Paths")
  for (const [k, v] of Object.entries({ directory: p.directory, worktree: p.worktree, config: Paths.config, data: Paths.data, cache: Paths.cache, state: Paths.state, logs: Paths.log, auth: Paths.auth })) {
    out(`  ${k.padEnd(10)} ${v}`)
  }
  out()
  out("Config files loaded")
  if (loaded.files.length === 0) out("  none")
  for (const f of loaded.files) out(`  ${f}`)
  for (const e of loaded.errors) out(`  ERROR ${e}`)
  out(`  project ${loaded.trusted ? "trusted" : "not trusted"} (${loaded.trustRoot})`)
  for (const b of loaded.blocked) out(`  ignored: ${b}`)
  out()
  out("Providers with credentials")
  const providers = Object.values(await allProviders()).filter((x) => x.source !== "none")
  if (providers.length === 0) out("  none")
  for (const x of providers) {
    const limit = x.maxConcurrency ? `  max ${x.maxConcurrency} at once${x.maxConcurrencySource === "diparnux" ? " (from the gateway's slots)" : ""}` : ""
    out(`  ${x.id.padEnd(14)} ${x.protocol.padEnd(9)} via ${x.source.padEnd(7)} ${Object.keys(x.models).length} models${limit}`)
    if (x.maxConcurrencyIgnored) out(`    ! ${x.maxConcurrencyIgnored}`)
    for (const source of x.tlsSources ?? []) out(`    trusts only ${source.label}${source.fingerprints[0] ? ` (SHA-256 ${source.fingerprints[0]})` : ""}`)
  }
  for (const x of Object.values(await allProviders()).filter((y) => y.problem)) {
    out(`  ${x.id.padEnd(14)} NOT USABLE: ${x.problem}`)
  }
  out()
  const { loadPlugins, pluginProblems } = await import("../../plugin")
  const plugins = await loadPlugins()
  out("Plugins")
  if (plugins.length === 0 && pluginProblems().length === 0) out("  none")
  for (const pl of plugins) out(`  ${pl.name.padEnd(20)} ${pl.source.padEnd(8)} ${Object.keys(pl.hooks).join(", ") || "no hooks"}`)
  for (const f of pluginProblems()) out(`  FAILED ${f.file}: ${f.error}`)
  out()
  out(`Agents     ${Object.keys(await listAgents()).join(", ")}`)
  out(`Commands   ${Object.keys(await listCommands()).join(", ")}`)
  out(`Skills     ${Object.keys(await listSkills()).join(", ") || "none"}`)
  out()
  out("Formatters")
  for (const f of await formatterStatus()) if (f.enabled) out(`  ${f.name} (${f.extensions.join(" ")})`)
  out()
  out("LSP servers (installed ones start on demand)")
  for (const s of BUILTIN_SERVERS) {
    const cmd = await resolveServer(s.id, p.worktree)
    out(`  ${s.id.padEnd(22)} ${cmd ? cmd[0] : installerFor(s.id) ? "not installed (offered automatically on first edit)" : "not installed"}`)
  }
  const mcpNames = Object.keys(loaded.config.mcp ?? {})
  if (mcpNames.length) {
    out()
    out("MCP servers")
    await startMcp()
    for (const s of mcpStatus()) out(`  ${s.name.padEnd(16)} ${s.status} ${s.error ? "- " + s.error.split("\n")[0] : `(${s.tools} tools)`}`)
  }
  return 0
}
