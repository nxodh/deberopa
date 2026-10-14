import { getConfig, readState, type ModelConfig } from "../config/config"
import { allCredentials } from "../auth/auth"
import { detectLocalServers, discoverOpenAIModels, fetchOperetaInfo, isLocalURL, lastDetectFailures, localAPIKey, type DetectedModel } from "./local"
import { getCatalog, type CatalogModel, type CatalogProvider } from "./models"
import { registerSecret } from "../util/redact"
import { loadProviderCA, TlsConfigError } from "./tls"
import { createLogger } from "../util/log"
import type { Model, ProviderInfo } from "./types"

const log = createLogger("provider")

/** Base URLs for providers whose catalog entry does not carry one. All speak OpenAI chat completions. */
const KNOWN_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta/openai",
  openrouter: "https://openrouter.ai/api/v1",
  groq: "https://api.groq.com/openai/v1",
  xai: "https://api.x.ai/v1",
  mistral: "https://api.mistral.ai/v1",
  deepseek: "https://api.deepseek.com",
  togetherai: "https://api.together.xyz/v1",
  "fireworks-ai": "https://api.fireworks.ai/inference/v1",
  cerebras: "https://api.cerebras.ai/v1",
  perplexity: "https://api.perplexity.ai",
  deepinfra: "https://api.deepinfra.com/v1/openai",
}

/** Providers tried first when nothing has been chosen yet. */
const PRIORITY = ["anthropic", "openai", "google", "openrouter", "xai", "groq", "deepseek", "mistral", "ollama", "lmstudio", "llamacpp", "vllm"]
const PREFERRED_MODELS: Record<string, string[]> = {
  anthropic: ["claude-opus-5-5", "claude-sonnet-5-5"],
}
const SMALL_HINTS = ["haiku", "mini", "flash", "nano", "small", "lite", "fast"]

function toModel(providerID: string, id: string, catalog?: CatalogModel, override?: ModelConfig): Model {
  return {
    id,
    providerID,
    name: override?.name ?? catalog?.name ?? id,
    limit: {
      context: override?.limit?.context ?? catalog?.limit?.context ?? 128_000,
      output: override?.limit?.output ?? catalog?.limit?.output ?? 8_192,
    },
    cost: {
      input: override?.cost?.input ?? catalog?.cost?.input ?? 0,
      output: override?.cost?.output ?? catalog?.cost?.output ?? 0,
      cacheRead: override?.cost?.cache_read ?? catalog?.cost?.cache_read ?? 0,
      cacheWrite: override?.cost?.cache_write ?? catalog?.cost?.cache_write ?? 0,
    },
    reasoning: override?.reasoning ?? catalog?.reasoning ?? false,
    toolCall: override?.tool_call ?? catalog?.tool_call ?? true,
    attachment: override?.attachment ?? catalog?.attachment ?? false,
    temperature: override?.temperature ?? catalog?.temperature ?? true,
    releaseDate: catalog?.release_date,
    options: override?.options,
  }
}

let cached: Promise<Record<string, ProviderInfo>> | undefined

export function resetProviders() {
  cached = undefined
}

/** Every provider we know about, including ones without credentials (`source: "none"`). */
export function allProviders(): Promise<Record<string, ProviderInfo>> {
  return (cached ??= build())
}

async function build(): Promise<Record<string, ProviderInfo>> {
  const [config, catalog, credentials] = await Promise.all([getConfig(), getCatalog(), allCredentials()])
  const result: Record<string, ProviderInfo> = {}
  /** `provider/model` keys whose context window is a guess (nothing in config, catalog or server said). */
  const assumedContext = new Set<string>()
  const ids = new Set([...Object.keys(catalog), ...Object.keys(config.provider ?? {})])

  for (const id of ids) {
    const entry: CatalogProvider | undefined = catalog[id]
    const override = config.provider?.[id]
    const isAnthropic = override?.protocol === "anthropic" || (!override?.protocol && (id === "anthropic" || entry?.npm === "@ai-sdk/anthropic"))
    let baseURL = override?.options?.baseURL ?? override?.api ?? entry?.api ?? KNOWN_BASE_URLS[id]
    // An Ollama endpoint defaults to Ollama's own API: its OpenAI-compatible one cannot set the
    // context window, so prompts silently get cut to 2-4K tokens. "protocol": "openai" opts out.
    const looksLikeOllama = !isAnthropic && !override?.protocol && (id === "ollama" || /:11434(\/|$)/.test(baseURL ?? ""))
    const protocol: ProviderInfo["protocol"] = isAnthropic ? "anthropic" : override?.protocol === "ollama" || looksLikeOllama ? "ollama" : "openai"
    if (protocol === "ollama") baseURL = (baseURL ?? "http://127.0.0.1:11434").replace(/\/+$/, "").replace(/\/v1$/, "")
    // Without an endpoint we cannot talk to it (Bedrock, Vertex and friends need bespoke auth).
    if (protocol !== "anthropic" && !baseURL) continue

    const env = override?.env ?? entry?.env ?? []
    const envKey = env.map((name) => process.env[name]).find((v) => v && v.trim() !== "")
    const stored = credentials[id]
    let apiKey: string | undefined
    let source: ProviderInfo["source"] = "none"
    if (override?.options?.apiKey) {
      apiKey = override.options.apiKey
      source = "config"
    } else if (envKey) {
      apiKey = envKey
      source = "env"
    } else if (stored) {
      apiKey = stored.type === "api" ? stored.key : stored.access
      source = "auth"
    } else if (override && !entry) {
      // A provider defined purely in config (Ollama, LM Studio, a proxy) needs no key.
      source = "config"
    }

    registerSecret(apiKey)

    // `options.ca`: trust exactly these authorities for this provider. A file that cannot be used
    // makes the provider unusable; it never falls back to the system store.
    let tls: ProviderInfo["tls"]
    let tlsSources: ProviderInfo["tlsSources"]
    let problem: string | undefined
    if (override?.options?.ca !== undefined) {
      try {
        const loaded = await loadProviderCA(override.options.ca, id)
        tls = loaded.tls
        tlsSources = loaded.sources
      } catch (err) {
        problem = err instanceof TlsConfigError ? err.message : `provider.${id}.options.ca: ${err instanceof Error ? err.message : String(err)}`
        log.warn(`provider ${id}: ${problem}`)
        source = "none"
      }
    }
    const models: Record<string, Model> = {}
    for (const [modelID, model] of Object.entries(entry?.models ?? {})) {
      if (model.status === "deprecated") continue
      models[modelID] = toModel(id, modelID, model, override?.models?.[modelID])
      if (model.limit?.context === undefined && override?.models?.[modelID]?.limit?.context === undefined) assumedContext.add(`${id}/${modelID}`)
    }
    for (const [modelID, model] of Object.entries(override?.models ?? {})) {
      const realID = model.id ?? modelID
      if (models[modelID]) continue
      models[modelID] = toModel(id, realID, entry?.models?.[realID], model)
      if (model.limit?.context === undefined && entry?.models?.[realID]?.limit?.context === undefined) assumedContext.add(`${id}/${modelID}`)
    }

    result[id] = {
      id,
      name: override?.name ?? entry?.name ?? id,
      protocol,
      baseURL,
      env,
      apiKey,
      headers: override?.options?.headers,
      timeout: override?.options?.timeout,
      source,
      // a server with its own CA is one the user runs or was given: treat it like a local one
      local: isLocalURL(baseURL) || !!tls,
      models,
      ...(tls ? { tls, tlsSources } : {}),
      ...(problem ? { problem } : {}),
    }
  }

  await addLocalProviders(result, config, assumedContext)
  for (const [id, provider] of Object.entries(result)) applyConcurrency(id, provider, config.provider?.[id]?.options?.max_concurrency)

  const disabled = new Set(config.disabled_providers ?? [])
  const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined
  for (const id of Object.keys(result)) {
    if (disabled.has(id) || (enabled && !enabled.has(id))) delete result[id]
  }
  return result
}

export const MAX_CONCURRENCY = 64

/**
 * `options.max_concurrency` wins when it is a usable integer. Otherwise a Opereta gateway that
 * reports a fixed slot count sets the limit (slots chosen by the server give no number to use).
 * A value that cannot be used is ignored and recorded, never guessed at.
 */
function applyConcurrency(id: string, provider: ProviderInfo, raw: unknown) {
  if (raw !== undefined && raw !== null) {
    if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= MAX_CONCURRENCY) {
      provider.maxConcurrency = raw
      provider.maxConcurrencySource = "config"
      return
    }
    provider.maxConcurrencyIgnored = `options.max_concurrency must be a whole number from 1 to ${MAX_CONCURRENCY} (got ${JSON.stringify(raw)}); requests are not limited`
    log.warn(`provider ${id}: ${provider.maxConcurrencyIgnored}`)
  }
  const slots = provider.opereta?.slots
  if (slots && !provider.opereta?.slotsAuto && !provider.maxConcurrencyIgnored) {
    provider.maxConcurrency = Math.min(slots, MAX_CONCURRENCY)
    provider.maxConcurrencySource = "opereta"
  }
}

function detectedToModel(providerID: string, d: DetectedModel, existing?: ModelConfig): Model {
  const base: CatalogModel = {
    id: d.id,
    name: d.name,
    reasoning: d.reasoning,
    tool_call: d.toolCall,
    attachment: d.attachment,
    temperature: true,
    cost: { input: 0, output: 0 },
    limit: { context: d.context ?? 8192, output: d.reasoning ? 16_384 : 8192 },
  }
  const model = toModel(providerID, d.id, base, existing)
  if (d.details || d.paramsB !== undefined) model.meta = { details: d.details, paramsB: d.paramsB }
  return model
}

/**
 * Servers the user runs themselves. Found ones are added when not configured, and fill in
 * models for ones that are. Config always wins, so a pinned `limit.context` is respected.
 */
async function addLocalProviders(result: Record<string, ProviderInfo>, config: Awaited<ReturnType<typeof getConfig>>, assumedContext: Set<string>) {
  const configured = Object.entries(result).filter(([, p]) => p.local && p.protocol !== "anthropic")
  const probing = !process.env.DEBEROPA_DISABLE_LOCAL_DETECT
  // Server detection and the per-provider lookups below are independent: run them side by side so
  // startup waits for the slowest one, not for the sum.
  const detecting = config.local_detect === false ? Promise.resolve([]) : detectLocalServers()

  await Promise.all(
    configured.map(async ([id, provider]) => {
      if (!provider.baseURL || !probing || provider.problem) return

      // providers configured by URL only: ask the server what it has
      if (Object.keys(provider.models).length === 0 && provider.protocol !== "ollama") {
        const found = await discoverOpenAIModels(provider.baseURL, provider.headers, provider.apiKey, undefined, provider.tls)
        for (const d of found) {
          provider.models[d.id] = detectedToModel(id, d, config.provider?.[id]?.models?.[d.id])
          if (d.context === undefined && config.provider?.[id]?.models?.[d.id]?.limit?.context === undefined) assumedContext.add(`${id}/${d.id}`)
        }
        if (found.length) provider.source = provider.source === "none" ? "config" : provider.source
      }

      // A Opereta gateway says how big each slot's context really is. Ask only addresses on this
      // machine or its network (never a hosted API), without credentials, and only to fill in a
      // guess: a window written in the config always wins.
      if (config.local_detect === false || provider.protocol === "ollama") return
      const info = await fetchOperetaInfo(provider.baseURL, undefined, undefined, provider.tls)
      if (!info) return
      provider.opereta = info
      if (!info.ctxPerSlot) return
      for (const [modelID, model] of Object.entries(provider.models)) {
        if (!assumedContext.has(`${id}/${modelID}`)) continue
        model.limit = { ...model.limit, context: info.ctxPerSlot }
      }
    }),
  )

  if (config.local_detect === false) return
  for (const server of await detecting) {
    const existing = result[server.id]
    if (existing && existing.source !== "none") {
      // configured by the user: add any models they did not list
      for (const d of Object.values(server.models)) {
        if (!existing.models[d.id]) existing.models[d.id] = detectedToModel(server.id, d, config.provider?.[server.id]?.models?.[d.id])
      }
      if (server.opereta && !existing.opereta) existing.opereta = server.opereta
      continue
    }
    const models: Record<string, Model> = {}
    for (const d of Object.values(server.models)) models[d.id] = detectedToModel(server.id, d, config.provider?.[server.id]?.models?.[d.id])
    // llama-server (and Opereta in front of it) can require a key; it is read from the environment
    // and goes only to the address that was detected.
    const key = server.id === "llamacpp" ? localAPIKey() : undefined
    result[server.id] = {
      id: server.id,
      name: config.provider?.[server.id]?.name ?? server.name,
      protocol: server.protocol,
      baseURL: server.baseURL,
      env: server.id === "llamacpp" ? ["OPERETA_API_KEY", "LLAMA_API_KEY"] : [],
      apiKey: key,
      headers: config.provider?.[server.id]?.options?.headers,
      timeout: config.provider?.[server.id]?.options?.timeout,
      source: key ? "env" : "local",
      local: true,
      models: { ...models, ...Object.fromEntries(Object.entries(result[server.id]?.models ?? {})) },
      ...(server.opereta ? { opereta: server.opereta } : {}),
    }
  }
}

/** Providers that can actually be called right now. */
export async function availableProviders(): Promise<ProviderInfo[]> {
  const all = await allProviders()
  return Object.values(all)
    .filter((p) => p.source !== "none")
    .sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name))
}

function rank(id: string) {
  const i = PRIORITY.indexOf(id)
  return i === -1 ? PRIORITY.length : i
}

export function parseModelRef(ref: string): { providerID: string; modelID: string } {
  const slash = ref.indexOf("/")
  if (slash === -1) return { providerID: "", modelID: ref }
  return { providerID: ref.slice(0, slash), modelID: ref.slice(slash + 1) }
}

export class ModelNotFoundError extends Error {
  constructor(
    public providerID: string,
    public modelID: string,
    hint?: string,
  ) {
    super(`Model not found: ${providerID}/${modelID}.${hint ? " " + hint : ""}`)
    this.name = "ModelNotFoundError"
  }
}

export async function getModel(providerID: string, modelID: string): Promise<{ provider: ProviderInfo; model: Model }> {
  const all = await allProviders()
  const provider = all[providerID]
  if (!provider) {
    // a server that is running but refused the probe is not "unknown": say what is actually wrong
    const refused = lastDetectFailures().find((f) => f.id === providerID)
    if (refused) {
      throw new ModelNotFoundError(
        providerID,
        modelID,
        `The server at ${refused.baseURL} answered ${refused.status}: it needs an API key. Set OPERETA_API_KEY (or LLAMA_API_KEY) and try again.`,
      )
    }
    throw new ModelNotFoundError(providerID, modelID, `Unknown provider "${providerID}". Run \`deberopa models\` to list what is available.`)
  }
  if (provider.problem) throw new ModelNotFoundError(providerID, modelID, `${provider.name} cannot be used: ${provider.problem}`)
  if (provider.source === "none") {
    throw new ModelNotFoundError(
      providerID,
      modelID,
      `No credentials for ${provider.name}. Run \`deberopa auth login\`${provider.env[0] ? ` or set ${provider.env[0]}` : ""}.`,
    )
  }
  // Unknown ids pass straight through: new models work before the catalog knows them.
  const model = provider.models[modelID] ?? toModel(providerID, modelID)
  return { provider, model }
}

function newest(models: Model[]): Model[] {
  return [...models].sort((a, b) => (b.releaseDate ?? "").localeCompare(a.releaseDate ?? "") || b.id.localeCompare(a.id))
}

function pickDefault(provider: ProviderInfo): Model | undefined {
  for (const id of PREFERRED_MODELS[provider.id] ?? []) if (provider.models[id]) return provider.models[id]
  const usable = Object.values(provider.models).filter((m) => m.toolCall)
  const big = usable.filter((m) => !SMALL_HINTS.some((h) => m.id.toLowerCase().includes(h)))
  return newest(big.length ? big : usable)[0]
}

/** config.model → last used → best model of the first provider with credentials. */
export async function defaultModel(): Promise<{ providerID: string; modelID: string } | undefined> {
  const config = await getConfig()
  if (config.model) {
    const ref = parseModelRef(config.model)
    if (ref.providerID) return ref
  }
  const available = await availableProviders()
  const state = await readState()
  if (state.model && available.some((p) => p.id === state.model!.providerID)) return state.model
  for (const provider of available) {
    const model = pickDefault(provider)
    if (model) return { providerID: provider.id, modelID: model.id }
  }
  return undefined
}

/** A cheap, fast model for titles and summaries; falls back to the main model. */
export async function smallModel(providerID: string, fallbackModelID: string): Promise<{ providerID: string; modelID: string }> {
  const config = await getConfig()
  if (config.small_model) {
    const ref = parseModelRef(config.small_model)
    if (ref.providerID) return ref
  }
  const provider = (await allProviders())[providerID]
  if (provider) {
    if (providerID === "anthropic" && provider.models["claude-haiku-5-5"]) return { providerID, modelID: "claude-haiku-5-5" }
    const small = newest(Object.values(provider.models).filter((m) => SMALL_HINTS.some((h) => m.id.toLowerCase().includes(h)) && m.toolCall))
    if (small[0]) return { providerID, modelID: small[0].id }
  }
  return { providerID, modelID: fallbackModelID }
}
