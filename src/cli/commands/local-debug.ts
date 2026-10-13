import { detectLocalServers, diparnuxUsable, lastDetectFailures, localAPIKey, ollamaBaseURL, type LocalEndpoints, type LocalServer } from "../../provider/local"
import { checkToolCalling, type ToolCheckResult } from "../../provider/toolcheck"

export interface LocalDebugOptions {
  /** Where to look; the usual local ports when omitted. */
  endpoints?: LocalEndpoints
  /** Send one model request per server to see whether tool calls work. Generates tokens, so opt-in. */
  checkTools?: boolean
  out: (line?: string) => void
  timeoutMs?: number
}

const n = (value: number) => value.toLocaleString("en-US")

function toolCheckLines(result: ToolCheckResult): string[] {
  const secs = `${(result.ms / 1000).toFixed(1)} s`
  switch (result.status) {
    case "ok":
      return [`  tool call check: ok (structured tool_calls, ${secs})`]
    case "recovered":
      return [
        `  tool call check: recovered from text (${secs})`,
        "    works in Vedecaps, which reads tool calls written as text; `diparnux serve toolcheck` counts only structured ones and reports a failure",
      ]
    case "failed":
      return [
        `  tool call check: FAILED (${result.detail ?? "no tool call"})`,
        "    the agent cannot read or edit files with this model. Use one whose chat template supports tools, and for llama-server start it with --jinja",
      ]
    case "unauthorized":
      return ["  tool call check: the server answered 401: it needs an API key (set DIPARNUX_API_KEY or LLAMA_API_KEY)"]
    case "error":
      return [`  tool call check: could not run (${result.detail ?? "unknown error"})`]
  }
}

function serverLines(server: LocalServer): string[] {
  const lines: string[] = []
  const d = server.diparnux
  if (d) {
    const parts = [`Diparnux ${d.version}`]
    if (d.state) parts.push(`server ${d.state}`)
    if (d.slots) parts.push(`${d.slots} slot${d.slots === 1 ? "" : "s"}`)
    else if (d.slotsAuto) parts.push("slots chosen by the server")
    if (d.ctxPerSlot) parts.push(`${n(d.ctxPerSlot)} ctx per slot`)
    lines.push("  " + parts.join(" · "))
    if (d.state && !diparnuxUsable(d)) lines.push(`    ! the server is ${d.state}; start it with: diparnux serve start`)
    if (d.slotsAuto) lines.push("    slots: chosen by the server; set options.max_concurrency if you see 429")
    if (d.slots && d.ctxPerSlot && d.ctxPerSlot < 8192) lines.push(`    ! ${n(d.ctxPerSlot)} tokens of context per slot is small; expect frequent compaction`)
  }
  return lines
}

/** The `vedecaps debug local` report. Returns an exit code. */
export async function runLocalDebug(opts: LocalDebugOptions): Promise<number> {
  const { out } = opts
  out("Probing local model servers (Ollama, LM Studio, llama.cpp, vLLM)...")
  const servers = await detectLocalServers(opts.endpoints ?? {}, opts.timeoutMs ?? 1500)
  const refused = lastDetectFailures()

  for (const f of refused) {
    out("")
    out(`llama.cpp  ${f.baseURL}  answered ${f.status}: this server needs an API key.`)
    out("  Set DIPARNUX_API_KEY (or LLAMA_API_KEY) and run this again.")
    if (localAPIKey()) out("  A key is set in the environment but the server did not accept it.")
  }

  if (servers.length === 0) {
    out("")
    if (refused.length === 0) {
      out("None found. Start one and run this again:")
      out(`  Ollama     ollama serve            (looked at ${ollamaBaseURL()}; set OLLAMA_HOST for another address)`)
      out("  LM Studio  start its local server  (looked at http://127.0.0.1:1234)")
      out("  llama.cpp  llama-server -m <model.gguf> -c 16384  (looked at http://127.0.0.1:8080)")
      out("  vLLM       vllm serve <model>      (looked at http://127.0.0.1:8000)")
      out('Any other OpenAI-compatible server can be added under "provider" in vedecaps.json.')
    }
    return 0
  }

  const key = localAPIKey()
  for (const server of servers) {
    out("")
    out(`${server.name}  ${server.baseURL}  (${server.protocol} protocol)`)
    for (const line of serverLines(server)) out(line)
    const models = Object.values(server.models)
    if (models.length === 0) out("  no models loaded or installed")
    for (const m of models) {
      const flags = [m.toolCall ? "tools" : "no tools", m.reasoning ? "thinking" : undefined, m.attachment ? "vision" : undefined].filter(Boolean).join(", ")
      const ctx = m.context ? `${n(m.context)} ctx${m.maxContext && m.maxContext > m.context ? ` of ${n(m.maxContext)}` : ""}` : "ctx unknown"
      // for a Diparnux gateway the server line above already says what the details would
      const details = m.details && !server.diparnux ? "  · " + m.details : ""
      out(`  ${m.id.padEnd(34)} ${ctx.padEnd(26)} ${flags}${details}`)
      if (!m.toolCall) out("    ! this model does not support tool calls, so the agent cannot use it")
      else if (m.context !== undefined && m.context < 8192 && !server.diparnux?.slots) {
        out("    ! context under 8K tokens: raise it (Ollama: limit.context in your config) or expect frequent compaction")
      }
    }

    if (opts.checkTools) {
      const first = server.protocol === "ollama" ? undefined : (server.diparnux?.model && server.models[server.diparnux.model] ? server.diparnux.model : models[0]?.id)
      if (server.protocol === "ollama") out("  tool call check: native API, not checked")
      else if (!first) out("  tool call check: no model to try")
      else {
        const result = await checkToolCalling({ baseURL: server.baseURL, model: first, apiKey: server.id === "llamacpp" ? key : undefined })
        for (const line of toolCheckLines(result)) out(line)
      }
    }
  }
  out("")
  out("Use one with:  vedecaps -m <provider>/<model>   (e.g. " + `${servers[0]!.id}/${Object.keys(servers[0]!.models)[0] ?? "model"})`)
  if (!opts.checkTools) out("Add --check-tools to send one request per server and see whether tool calls work.")
  return 0
}
