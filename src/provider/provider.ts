import { getConfig, readState, type ModelConfig } from "../config/config"
import { allCredentials } from "../auth/auth"
import { getCatalog, type CatalogModel, type CatalogProvider } from "./models"
import { registerSecret } from "../util/redact"
import type { Model, ProviderInfo } from "./types"

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
const PRIORITY = ["anthropic", "openai", "google", "openrouter", "xai", "groq", "deepseek", "mistral"]
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
  const ids = new Set([...Object.keys(catalog), ...Object.keys(config.provider ?? {})])

  for (const id of ids) {
    const entry: CatalogProvider | undefined = catalog[id]
    const override = config.provider?.[id]
    const isAnthropic = override?.protocol === "anthropic" || (!override?.protocol && (id === "anthropic" || entry?.npm === "@ai-sdk/anthropic"))
    const protocol = isAnthropic ? "anthropic" : "openai"
    const baseURL = override?.options?.baseURL ?? override?.api ?? entry?.api ?? KNOWN_BASE_URLS[id]
    // Without an endpoint we cannot talk to it (Bedrock, Vertex and friends need bespoke auth).
    if (protocol === "openai" && !baseURL) continue

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
    const models: Record<string, Model> = {}
    for (const [modelID, model] of Object.entries(entry?.models ?? {})) {
      if (model.status === "deprecated") continue
      models[modelID] = toModel(id, modelID, model, override?.models?.[modelID])
    }
    for (const [modelID, model] of Object.entries(override?.models ?? {})) {
      const realID = model.id ?? modelID
      if (!models[modelID]) models[modelID] = toModel(id, realID, entry?.models?.[realID], model)
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
      models,
    }
  }

  const disabled = new Set(config.disabled_providers ?? [])
  const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined
  for (const id of Object.keys(result)) {
    if (disabled.has(id) || (enabled && !enabled.has(id))) delete result[id]
  }
  return result
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
    throw new ModelNotFoundError(providerID, modelID, `Unknown provider "${providerID}". Run \`vedecaps models\` to list what is available.`)
  }
  if (provider.source === "none") {
    throw new ModelNotFoundError(
      providerID,
      modelID,
      `No credentials for ${provider.name}. Run \`vedecaps auth login\`${provider.env[0] ? ` or set ${provider.env[0]}` : ""}.`,
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
