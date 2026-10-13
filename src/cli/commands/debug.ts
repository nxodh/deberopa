import os from "node:os"
import { Paths, VERSION } from "../../global"
import { project } from "../../project"
import { loadConfig } from "../../config/config"
import { allProviders } from "../../provider/provider"
import { formatterStatus } from "../../format/format"
import { BUILTIN_SERVERS } from "../../lsp"
import { detectShell, which } from "../../util/shell"
import { listAgents } from "../../agent/agent"
import { listSkills } from "../../skill/skill"
import { listCommands } from "../../command/command"
import { startMcp, mcpStatus } from "../../mcp"
import { parse, type CommandSpec } from "../args"
import { bootstrap } from "../bootstrap"

export const spec: CommandSpec = {
  usage: "vedecaps debug [config|paths]",
  description: "show paths, loaded config, providers and tooling (useful for bug reports)",
  options: { help: { type: "boolean", short: "h", description: "show this help" } },
}

export async function main(argv: string[]): Promise<number> {
  const { positionals } = parse(argv, spec.options!)
  await bootstrap()
  const out = (s = "") => process.stdout.write(s + "\n")
  const loaded = await loadConfig()
  if (positionals[0] === "config") {
    out(JSON.stringify(loaded.config, null, 2))
    return 0
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
  out()
  out("Providers with credentials")
  const providers = Object.values(await allProviders()).filter((x) => x.source !== "none")
  if (providers.length === 0) out("  none")
  for (const x of providers) out(`  ${x.id.padEnd(14)} ${x.protocol.padEnd(9)} via ${x.source.padEnd(7)} ${Object.keys(x.models).length} models`)
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
    const cmd = await s.resolve(p.worktree)
    out(`  ${s.id.padEnd(22)} ${cmd ? cmd[0] : "not installed"}`)
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
