import { DEFAULT_PORTS, startHint } from "./localmode"
import { describeOpereta, type DetectFailure, type LocalServer } from "./local"
import type { ToolCheckResult } from "./toolcheck"

const n = (value: number) => value.toLocaleString("en-US")

/** What was found on this machine, as Markdown for a dialog. Also says how to start what was not found. */
export function localServersMarkdown(servers: LocalServer[], failures: DetectFailure[] = []): string {
  const lines: string[] = []
  if (servers.length === 0 && failures.length === 0) {
    lines.push("## No local model server answered", "", "Deberopa looked on the usual ports:", "")
    for (const p of DEFAULT_PORTS) lines.push(`- **${p.name}** on port ${p.port}: ${startHint(p.kind)}`)
    lines.push("", "Start one, then run `/local` again. For a hosted model, use `/connect` to add an API key.")
    return lines.join("\n")
  }
  lines.push("## Local model servers", "")
  for (const s of servers) {
    const models = Object.values(s.models)
    lines.push(`- **${s.name}** at ${s.baseURL} · ${n(models.length)} model${models.length === 1 ? "" : "s"}`)
    if (s.opereta) lines.push(`  - ${describeOpereta(s.opereta)}`)
    for (const m of models.slice(0, 8)) lines.push(`  - \`${s.id}/${m.id}\`${m.context ? ` · ${n(m.context)} ctx` : ""}`)
    if (models.length > 8) lines.push(`  - … and ${models.length - 8} more (/models)`)
    if (models.length === 0) lines.push(s.id === "ollama" ? "  - no models yet. Download one with `deberopa local pull qwen3:8b` (or `/pull qwen3:8b` in the terminal UI)" : "  - the server reports no model")
  }
  for (const f of failures) lines.push(`- **${f.id}** at ${f.baseURL} answered ${f.status}: it needs an API key (set OPERETA_API_KEY or LLAMA_API_KEY)`)
  return lines.join("\n")
}

/** The tool-call check result as plain sentences. */
export function toolCheckSummary(result: ToolCheckResult): string {
  const secs = `${(result.ms / 1000).toFixed(1)} s`
  switch (result.status) {
    case "ok":
      return `Tool calls work: the model answered with a structured call (${secs}).`
    case "recovered":
      return `Tool calls work, with help: the model wrote the call as text and Deberopa recovered it (${secs}). Fine here; other tools that read only structured calls will fail.`
    case "failed":
      return `Tool calls do not work${result.detail ? `: ${result.detail}` : ""}. The agent cannot read or edit files with this model. Use one whose template supports tools; for llama-server start it with --jinja.`
    case "unauthorized":
      return "The server answered 401: it needs an API key (set OPERETA_API_KEY or LLAMA_API_KEY)."
    case "error":
      return `The check could not run: ${result.detail ?? "unknown error"}.`
  }
}
