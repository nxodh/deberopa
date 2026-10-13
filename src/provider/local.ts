import { VERSION } from "../global"
import { createLogger } from "../util/log"

const log = createLogger("local")

/** Context window requested from a local server unless the user says otherwise; KV cache memory grows with it. */
export const DEFAULT_NUM_CTX_CAP = 16_384

export interface DetectedModel {
  id: string
  name: string
  /** Context window we will actually use (already capped for servers that allocate it up front). */
  context?: number
  /** The largest context the model supports. */
  maxContext?: number
  toolCall: boolean
  reasoning: boolean
  attachment: boolean
  details?: string
  /** Parameter count in billions, when the server reports it. */
  paramsB?: number
}

/** "8.2B", "751.63M", "70B" -> billions. */
export function parseParamSize(text: unknown): number | undefined {
  const m = /^\s*([\d.]+)\s*([KMBT])\s*$/i.exec(String(text ?? ""))
  if (!m) return undefined
  const n = Number(m[1])
  if (!Number.isFinite(n)) return undefined
  return { K: 1e-6, M: 1e-3, B: 1, T: 1e3 }[m[2]!.toUpperCase() as "K" | "M" | "B" | "T"] * n
}

export interface LocalServer {
  id: "ollama" | "lmstudio" | "llamacpp" | "vllm"
  name: string
  protocol: "ollama" | "openai"
  baseURL: string
  models: Record<string, DetectedModel>
}

export interface LocalEndpoints {
  ollama?: string
  lmstudio?: string
  llamacpp?: string
  vllm?: string
}

/** True for loopback, link-local, private-network and `.local` hosts: servers the user runs themselves. */
export function isLocalURL(url: string | undefined): boolean {
  if (!url) return false
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "")
  } catch {
    return false
  }
  if (host === "localhost" || host === "::1" || host.endsWith(".local") || host.endsWith(".localhost") || host === "host.docker.internal") return true
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host)
  if (v4) {
    const a = Number(v4[1])
    const b = Number(v4[2])
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || a === 0
  }
  return /^f[cd][0-9a-f]{2}:/.test(host) || host.startsWith("fe80:")
}

/** `OLLAMA_HOST` may be "host", "host:port", "0.0.0.0:11434" or a full URL. */
export function ollamaBaseURL(env = process.env.OLLAMA_HOST): string {
  const raw = (env ?? "").trim()
  if (!raw) return "http://127.0.0.1:11434"
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`
  try {
    const url = new URL(withScheme)
    // a server bound to 0.0.0.0 is reached through loopback
    const host = url.hostname === "0.0.0.0" || url.hostname === "[::]" ? "127.0.0.1" : url.hostname
    return `${url.protocol}//${host}:${url.port || "11434"}`
  } catch {
    return "http://127.0.0.1:11434"
  }
}

async function getJSON(url: string, timeoutMs: number, init: RequestInit = {}): Promise<any | undefined> {
  try {
    const res = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs), headers: { "User-Agent": `vedecaps/${VERSION}`, ...init.headers } })
    if (!res.ok) return undefined
    return await res.json()
  } catch {
    return undefined
  }
}

const sizeLabel = (bytes?: number) => (bytes ? `${(bytes / 1e9).toFixed(1)} GB` : undefined)

async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))))
  return out
}

export async function detectOllama(baseURL: string, timeoutMs = 700): Promise<LocalServer | undefined> {
  const tags = await getJSON(`${baseURL}/api/tags`, timeoutMs)
  if (!tags || !Array.isArray(tags.models)) return undefined
  const entries = (tags.models as any[]).filter((m) => typeof m?.name === "string").slice(0, 60)
  const shown = await inBatches(entries, 8, async (entry) => {
    const info = await getJSON(`${baseURL}/api/show`, 4000, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: entry.name }),
    })
    return { entry, info }
  })

  const models: Record<string, DetectedModel> = {}
  for (const { entry, info } of shown) {
    const capabilities: string[] = Array.isArray(info?.capabilities) ? info.capabilities : []
    // embedding-only models cannot chat
    if (capabilities.length && !capabilities.includes("completion")) continue
    let maxContext: number | undefined
    for (const [key, value] of Object.entries<any>(info?.model_info ?? {})) {
      if (key.endsWith(".context_length") && typeof value === "number") maxContext = value
    }
    const reasoning = capabilities.includes("thinking")
    const cap = Math.min(maxContext ?? DEFAULT_NUM_CTX_CAP, DEFAULT_NUM_CTX_CAP)
    const parts = [entry.details?.parameter_size, entry.details?.quantization_level, sizeLabel(entry.size)].filter(Boolean)
    models[entry.name] = {
      id: entry.name,
      name: entry.name,
      context: cap,
      maxContext,
      // old servers do not report capabilities; assume tools work and let the text fallback catch the rest
      toolCall: capabilities.length ? capabilities.includes("tools") : true,
      reasoning,
      attachment: capabilities.includes("vision"),
      details: parts.join(" · ") || undefined,
      paramsB: parseParamSize(entry.details?.parameter_size),
    }
  }
  return { id: "ollama", name: "Ollama", protocol: "ollama", baseURL, models }
}

export async function detectLMStudio(baseURL: string, timeoutMs = 700): Promise<LocalServer | undefined> {
  const root = baseURL.replace(/\/v1\/?$/, "")
  const rich = await getJSON(`${root}/api/v0/models`, timeoutMs)
  const models: Record<string, DetectedModel> = {}
  if (rich && Array.isArray(rich.data)) {
    for (const m of rich.data as any[]) {
      if (typeof m?.id !== "string" || m.type === "embeddings") continue
      const maxContext = typeof m.max_context_length === "number" ? m.max_context_length : undefined
      const loaded = typeof m.loaded_context_length === "number" ? m.loaded_context_length : undefined
      models[m.id] = {
        id: m.id,
        name: m.id,
        context: loaded ?? maxContext,
        maxContext,
        // models without the "tool_use" tag still often work through the prompt template and the text fallback
        toolCall: true,
        reasoning: /r1|qwq|think|reason|gpt-oss/i.test(m.id),
        attachment: m.type === "vlm",
        details: [m.arch, m.quantization, m.state === "loaded" ? "loaded" : undefined].filter(Boolean).join(" · ") || undefined,
      }
    }
  } else {
    const plain = await getJSON(`${root}/v1/models`, timeoutMs)
    if (!plain || !Array.isArray(plain.data)) return undefined
    for (const m of plain.data as any[]) {
      if (typeof m?.id === "string" && !/embed/i.test(m.id)) {
        models[m.id] = { id: m.id, name: m.id, toolCall: true, reasoning: /r1|qwq|think|reason|gpt-oss/i.test(m.id), attachment: false }
      }
    }
  }
  return { id: "lmstudio", name: "LM Studio", protocol: "openai", baseURL: `${root}/v1`, models }
}

export async function detectLlamaCpp(baseURL: string, timeoutMs = 700): Promise<LocalServer | undefined> {
  const root = baseURL.replace(/\/v1\/?$/, "")
  // /props exists only on llama.cpp's server, which keeps port 8080 from matching unrelated services
  const props = await getJSON(`${root}/props`, timeoutMs)
  if (!props || typeof props !== "object") return undefined
  const listed = await getJSON(`${root}/v1/models`, timeoutMs)
  const context = props.default_generation_settings?.n_ctx ?? props.n_ctx
  const models: Record<string, DetectedModel> = {}
  const rows: any[] = Array.isArray(listed?.data) ? listed.data : []
  const ids = rows.map((r) => r?.id).filter((id): id is string => typeof id === "string")
  if (ids.length === 0) ids.push(String(props.model_alias ?? props.model_path ?? "default").split(/[\\/]/).pop()!)
  for (const id of ids) {
    models[id] = {
      id,
      name: id,
      context: typeof context === "number" ? context : undefined,
      maxContext: typeof context === "number" ? context : undefined,
      toolCall: true,
      reasoning: /r1|qwq|think|reason|gpt-oss/i.test(id),
      attachment: !!props.modalities?.vision,
    }
  }
  return { id: "llamacpp", name: "llama.cpp", protocol: "openai", baseURL: `${root}/v1`, models }
}

export async function detectVLLM(baseURL: string, timeoutMs = 700): Promise<LocalServer | undefined> {
  const root = baseURL.replace(/\/v1\/?$/, "")
  const listed = await getJSON(`${root}/v1/models`, timeoutMs)
  if (!listed || !Array.isArray(listed.data)) return undefined
  const models: Record<string, DetectedModel> = {}
  for (const m of listed.data as any[]) {
    // max_model_len is vLLM-specific; without it this is some other service on port 8000
    if (typeof m?.id !== "string" || typeof m.max_model_len !== "number") continue
    models[m.id] = { id: m.id, name: m.id, context: m.max_model_len, maxContext: m.max_model_len, toolCall: true, reasoning: /r1|qwq|think|reason/i.test(m.id), attachment: false }
  }
  if (Object.keys(models).length === 0) return undefined
  return { id: "vllm", name: "vLLM", protocol: "openai", baseURL: `${root}/v1`, models }
}

/** Probe the usual local ports in parallel. Never throws; servers that do not answer are skipped. */
export async function detectLocalServers(endpoints: LocalEndpoints = {}, timeoutMs = 700): Promise<LocalServer[]> {
  if (process.env.VEDECAPS_DISABLE_LOCAL_DETECT) return []
  const found = await Promise.all([
    detectOllama(endpoints.ollama ?? ollamaBaseURL(), timeoutMs),
    detectLMStudio(endpoints.lmstudio ?? "http://127.0.0.1:1234", timeoutMs),
    detectLlamaCpp(endpoints.llamacpp ?? "http://127.0.0.1:8080", timeoutMs),
    detectVLLM(endpoints.vllm ?? "http://127.0.0.1:8000", timeoutMs),
  ])
  const servers = found.filter((s): s is LocalServer => !!s)
  for (const server of servers) log.info(`detected ${server.name} at ${server.baseURL} (${Object.keys(server.models).length} models)`)
  return servers
}

/** Model ids of any OpenAI-compatible server, for providers configured by URL only. */
export async function discoverOpenAIModels(baseURL: string, headers: Record<string, string> = {}, apiKey?: string, timeoutMs = 1500): Promise<DetectedModel[]> {
  const auth: Record<string, string> = apiKey ? { authorization: `Bearer ${apiKey}` } : {}
  const listed = await getJSON(`${baseURL.replace(/\/+$/, "")}/models`, timeoutMs, { headers: { ...headers, ...auth } })
  const rows: any[] = Array.isArray(listed?.data) ? listed.data : Array.isArray(listed?.models) ? listed.models : []
  const out: DetectedModel[] = []
  for (const m of rows) {
    const id = typeof m === "string" ? m : (m?.id ?? m?.name)
    if (typeof id !== "string" || /embed/i.test(id)) continue
    const context = [m?.max_model_len, m?.context_length, m?.context_window, m?.max_context_length].find((v) => typeof v === "number")
    out.push({ id, name: id, context, maxContext: context, toolCall: true, reasoning: /r1|qwq|think|reason|gpt-oss/i.test(id), attachment: false })
  }
  return out
}
