import fs from "node:fs/promises"
import path from "node:path"
import { Paths, VERSION } from "../global"
import { createLogger } from "../util/log"

const log = createLogger("models")

/** Shape of https://models.dev/api.json (only the fields we use). */
export interface CatalogModel {
  id: string
  name?: string
  attachment?: boolean
  reasoning?: boolean
  temperature?: boolean
  tool_call?: boolean
  release_date?: string
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number }
  limit?: { context?: number; output?: number }
  status?: string
}

export interface CatalogProvider {
  id: string
  name?: string
  env?: string[]
  npm?: string
  api?: string
  models: Record<string, CatalogModel>
}

export type Catalog = Record<string, CatalogProvider>

const URL = process.env.VEDECAPS_MODELS_URL || "https://models.dev/api.json"
const TTL = 24 * 60 * 60 * 1000
const cacheFile = () => path.join(Paths.cache, "models.json")

const claude = (id: string, name: string, input: number, output: number, cacheRead: number, context = 1_000_000, out = 128_000): CatalogModel => ({
  id,
  name,
  attachment: true,
  reasoning: true,
  temperature: false,
  tool_call: true,
  cost: { input, output, cache_read: cacheRead, cache_write: input * 1.25 },
  limit: { context, output: out },
})

/**
 * Offline fallback, used only until the live catalog has been fetched once.
 * Kept deliberately small: models.dev is the source of truth.
 */
const BUILTIN: Catalog = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    env: ["ANTHROPIC_API_KEY"],
    npm: "@ai-sdk/anthropic",
    models: {
      "claude-opus-5-5": claude("claude-opus-5-5", "Claude Opus 5.5", 4, 20, 0.2),
      "claude-sonnet-5-5": claude("claude-sonnet-5-5", "Claude Sonnet 5.5", 2, 10, 0.2),
      "claude-haiku-5-5": claude("claude-haiku-5-5", "Claude Haiku 5.5", 0.1, 0.5, 0.01),
      "claude-fable-5-1": claude("claude-fable-5-1", "Claude Fable 5.1", 10, 50, 0.25),
    },
  },
  openai: { id: "openai", name: "OpenAI", env: ["OPENAI_API_KEY"], npm: "@ai-sdk/openai", models: {} },
  google: {
    id: "google",
    name: "Google",
    env: ["GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"],
    npm: "@ai-sdk/google",
    models: {},
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    env: ["OPENROUTER_API_KEY"],
    npm: "@openrouter/ai-sdk-provider",
    api: "https://openrouter.ai/api/v1",
    models: {},
  },
}

let memory: Catalog | undefined
let refreshing: Promise<void> | undefined

async function readCache(): Promise<{ catalog: Catalog; mtime: number } | undefined> {
  try {
    const file = cacheFile()
    const [text, stat] = await Promise.all([fs.readFile(file, "utf8"), fs.stat(file)])
    const catalog = JSON.parse(text) as Catalog
    if (typeof catalog !== "object" || catalog === null) return undefined
    return { catalog, mtime: stat.mtimeMs }
  } catch {
    return undefined
  }
}

export async function refreshCatalog(timeoutMs = 10_000): Promise<boolean> {
  if (process.env.VEDECAPS_DISABLE_MODELS_FETCH) return false
  try {
    const res = await fetch(URL, {
      headers: { "User-Agent": `vedecaps/${VERSION}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const text = await res.text()
    const parsed = JSON.parse(text) as Catalog
    if (typeof parsed !== "object" || parsed === null || Object.keys(parsed).length === 0) throw new Error("empty catalog")
    await fs.mkdir(Paths.cache, { recursive: true })
    await fs.writeFile(cacheFile(), text)
    memory = parsed
    return true
  } catch (err) {
    log.warn("catalog refresh failed", err)
    return false
  }
}

/**
 * The model catalog. Never blocks startup on the network for long: a cached copy is used
 * immediately and refreshed in the background once it is stale.
 */
export async function getCatalog(): Promise<Catalog> {
  if (memory) return memory
  const cached = await readCache()
  if (cached) {
    memory = cached.catalog
    if (Date.now() - cached.mtime > TTL) refreshing ??= refreshCatalog().then(() => {})
    return memory
  }
  // First run: give the network a short chance so the model list is complete from the start.
  if (await refreshCatalog(4_000)) return memory!
  memory = BUILTIN
  return memory
}

/** Test hook. */
export function setCatalog(catalog: Catalog | undefined) {
  memory = catalog
}
