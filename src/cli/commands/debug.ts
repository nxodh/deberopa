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
  usage: "vedecaps debug [config|local]",
  description: "show paths, loaded config, providers and tooling (useful for bug reports)",
  options: { help: { type: "boolean", short: "h", description: "show this help" } },
}

export async function main(argv: string[]): Promise<number> {
  const { positionals } = parse(argv, spec.options!)
  await bootstrap()
  const out = (s = "") => process.stdout.write(s + "\n")
  const loaded = await loadConfig()
  if (positionals[0] === "config") {
    out(JSON.stringify(redactDeep(loaded.config), null, 2))
    return 0
  }
  if (positionals[0] === "local") {
    const { detectLocalServers, ollamaBaseURL } = await import("../../provider/local")
    out("Probing local model servers (Ollama, LM Studio, llama.cpp, vLLM)...")
    const servers = await detectLocalServers({}, 1500)
    if (servers.length === 0) {
      out("")
      out("None found. Start one and run this again:")
      out(`  Ollama     ollama serve            (looked at ${ollamaBaseURL()}; set OLLAMA_HOST for another address)`)
      out("  LM Studio  start its local server  (looked at http://127.0.0.1:1234)")
      out("  llama.cpp  llama-server -m <model.gguf> -c 16384  (looked at http://127.0.0.1:8080)")
      out("  vLLM       vllm serve <model>      (looked at http://127.0.0.1:8000)")
      out("Any other OpenAI-compatible server can be added under \"provider\" in vedecaps.json.")
      return 0
    }
    for (const server of servers) {
      out("")
      out(`${server.name}  ${server.baseURL}  (${server.protocol} protocol)`)
      const models = Object.values(server.models)
      if (models.length === 0) out("  no models loaded or installed")
      for (const m of models) {
        const flags = [m.toolCall ? "tools" : "no tools", m.reasoning ? "thinking" : undefined, m.attachment ? "vision" : undefined].filter(Boolean).join(", ")
        const ctx = m.context ? `${m.context.toLocaleString("en-US")} ctx${m.maxContext && m.maxContext > m.context ? ` of ${m.maxContext.toLocaleString("en-US")}` : ""}` : "ctx unknown"
        out(`  ${m.id.padEnd(34)} ${ctx.padEnd(26)} ${flags}${m.details ? "  · " + m.details : ""}`)
        if (!m.toolCall) out("    ! this model does not support tool calls, so the agent cannot use it")
        else if (m.context !== undefined && m.context < 8192) out("    ! context under 8K tokens: raise it (Ollama: limit.context in your config) or expect frequent compaction")
      }
    }
    out("")
    out("Use one with:  vedecaps -m <provider>/<model>   (e.g. " + `${servers[0]!.id}/${Object.keys(servers[0]!.models)[0] ?? "model"})`)
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
  out(`  project ${loaded.trusted ? "trusted" : "not trusted"} (${loaded.trustRoot})`)
  for (const b of loaded.blocked) out(`  ignored: ${b}`)
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
