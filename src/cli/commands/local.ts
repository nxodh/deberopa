import { detectLocalServers, lastDetectFailures } from "../../provider/local"
import { modelMode, describeMode, probeSlots, pullOllamaModel, toolCheckModel, validPullName } from "../../provider/localmode"
import { localServersMarkdown, toolCheckSummary } from "../../provider/localreport"
import { allProviders, defaultModel, getModel } from "../../provider/provider"
import { UsageError, type CommandSpec } from "../args"
import { bootstrap } from "../bootstrap"

export const spec: CommandSpec = {
  usage: "deberopa local [servers|check [provider/model]|pull <model>|status]",
  description: "local model servers: what is running, whether a model can call tools, download a model",
  examples: [
    "deberopa local                          # what is running, and how to start what is not",
    "deberopa local check                    # can the default model call tools?",
    "deberopa local check ollama/qwen3:8b",
    "deberopa local pull qwen3:8b            # download into Ollama, with progress",
    "deberopa local status                   # how the default model is used: prompt mode, context, slots",
  ],
}

const out = (line = "") => process.stdout.write(line + "\n")

/** Markdown headings and emphasis are noise on a plain terminal. */
const plain = (markdown: string) => markdown.replace(/^#+\s*/gm, "").replace(/\*\*/g, "").replace(/`/g, "")

export async function main(argv: string[]): Promise<number> {
  const [action = "servers", ...rest] = argv
  await bootstrap()
  if (action === "servers" || action === "list") {
    const servers = await detectLocalServers({}, 1500)
    out(plain(localServersMarkdown(servers, lastDetectFailures())))
    return 0
  }
  if (action === "check") {
    const ref = rest[0] ? parseRef(rest[0]) : await defaultModel()
    if (!ref) {
      process.stderr.write("No model to check. Pass provider/model, or start a local server first (deberopa local).\n")
      return 1
    }
    out(`Asking ${ref.providerID}/${ref.modelID} to call a tool…`)
    const result = await toolCheckModel(ref.providerID, ref.modelID)
    out(toolCheckSummary(result))
    return result.status === "ok" || result.status === "recovered" ? 0 : 1
  }
  if (action === "pull") {
    const model = rest[0]
    if (!validPullName(model)) throw new UsageError("Usage: deberopa local pull <model>   (for example qwen3:8b)")
    const providers = Object.values(await allProviders()).filter((p) => p.protocol === "ollama" && p.baseURL)
    const target = providers[0]
    if (!target) {
      process.stderr.write("No Ollama server is configured or running. Start it first (deberopa local shows how).\n")
      return 1
    }
    let lastLine = ""
    try {
      await pullOllamaModel(target.id, model, (p) => {
        const pct = p.total && p.completed !== undefined ? ` ${Math.round((p.completed / p.total) * 100)}%` : ""
        const line = `${p.status}${pct}`
        if (line === lastLine) return
        lastLine = line
        out(line)
      })
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
      return 1
    }
    out(`${model} is ready: deberopa -m ${target.id}/${model}`)
    return 0
  }
  if (action === "status") {
    const ref = rest[0] ? parseRef(rest[0]) : await defaultModel()
    if (!ref) {
      out("No model selected. Run `deberopa local` to see what is available.")
      return 0
    }
    const { provider, model } = await getModel(ref.providerID, ref.modelID)
    const mode = modelMode(provider, model)
    out(`${provider.name} · ${model.name}${provider.local ? " (local)" : ""}`)
    out(`  ${describeMode(mode)}`)
    out(`  context window ${model.limit.context.toLocaleString("en-US")} tokens`)
    if (provider.maxConcurrency) out(`  at most ${provider.maxConcurrency} requests at once`)
    if (provider.local && provider.protocol === "openai" && provider.baseURL) {
      const slots = await probeSlots(provider.baseURL, provider.apiKey)
      out(slots ? `  slots ${slots.busy} busy of ${slots.total}${slots.ctxPerSlot ? ` · ${slots.ctxPerSlot.toLocaleString("en-US")} ctx each` : ""}` : "  slots: the server does not expose /slots")
    }
    return 0
  }
  throw new UsageError(`Unknown action "${action}". Use servers, check, pull or status.`)
}

function parseRef(text: string): { providerID: string; modelID: string } {
  const slash = text.indexOf("/")
  if (slash <= 0) throw new UsageError('Model must look like "provider/model".')
  return { providerID: text.slice(0, slash), modelID: text.slice(slash + 1) }
}
