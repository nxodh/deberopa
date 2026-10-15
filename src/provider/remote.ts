import net from "node:net"
import os from "node:os"
import path from "node:path"
import { setCredential, removeCredential } from "../auth/auth"
import { editGlobalConfig, getConfig } from "../config/config"
import { registerSecret, redact } from "../util/redact"
import { detectLlamaCpp, detectLMStudio, detectOllama, detectVLLM, discoverOpenAIModels, isLocalURL, probe, type DetectedModel, type OperetaInfo, type ServerAccess } from "./local"
import { DEFAULT_PORTS } from "./localmode"
import { allProviders, KNOWN_BASE_URLS, resetProviders } from "./provider"
import { getCatalog } from "./models"
import { describeTlsError, isInlinePEM, loadProviderCA, tlsErrorCode, type ProviderTls } from "./tls"

/**
 * Model servers on another computer: a host the user names (or finds with a scan) whose models
 * serve this machine's agent. The files, the tools and the session stay here; only inference is
 * remote. A host is an ordinary provider in the global config marked `remote: true`, with its key
 * in the credential store.
 */

export type ServerKind = "ollama" | "lmstudio" | "llamacpp" | "vllm" | "openai"

export interface RemoteServer {
  kind: ServerKind
  name: string
  protocol: "ollama" | "openai"
  /** The address to configure a provider with (OpenAI-compatible servers end in /v1). */
  baseURL: string
  models: DetectedModel[]
  opereta?: OperetaInfo
}

export type ProblemCode = "bad-url" | "unreachable" | "timeout" | "redirect" | "tls" | "needs-key" | "key-refused" | "not-a-model-server" | "key-over-plain-http"

export interface RemoteProblem {
  code: ProblemCode
  message: string
}

export interface RemoteCheck {
  ok: boolean
  /** The address as understood: scheme, host and port, no path. */
  url: string
  /** Time of one plain request to the server, in milliseconds. */
  latencyMs?: number
  server?: RemoteServer
  problem?: RemoteProblem
}

export interface RemoteHost {
  id: string
  name: string
  url: string
  protocol: "ollama" | "openai"
  hasKey: boolean
  /** Whether the host has its own certificate authority configured. */
  hasCA: boolean
}

const KIND_NAME: Record<ServerKind, string> = { ollama: "Ollama", lmstudio: "LM Studio", llamacpp: "llama.cpp", vllm: "vLLM", openai: "OpenAI-compatible server" }

const LISTEN_HINT =
  "On the server computer make it listen on the network, not only on localhost (Ollama: OLLAMA_HOST=0.0.0.0, llama-server: --host 0.0.0.0), and allow its port in the firewall."

/** Why an address cannot be used, or the normalised `scheme://host:port`. A `/v1` suffix is dropped. */
export function parseHost(input: string): { ok: true; root: string; host: string; secure: boolean } | { ok: false; message: string } {
  const text = input.trim()
  if (!text) return { ok: false, message: "The address is empty." }
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`)
  } catch {
    return { ok: false, message: `"${redact(text)}" is not an address. Use host, host:port or http(s)://host:port.` }
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, message: "Only http:// and https:// addresses are supported." }
  if (url.username || url.password) return { ok: false, message: "Do not put a user name or password in the address; give the key separately." }
  if (!url.hostname) return { ok: false, message: "The address has no host." }
  const pathname = url.pathname.replace(/\/+$/, "")
  if (pathname !== "" && pathname !== "/v1") return { ok: false, message: `The address should end at the host and port (got the path ${redact(pathname)}).` }
  const root = `${url.protocol}//${url.host}`
  return { ok: true, root, host: url.hostname.toLowerCase().replace(/^\[|\]$/g, ""), secure: url.protocol === "https:" }
}

/** Private networks plus the 100.64.0.0/10 range VPNs such as Tailscale use: a plain-HTTP key does not cross the open internet. */
function privateHost(root: string): boolean {
  if (isLocalURL(root)) return true
  try {
    const host = new URL(root).hostname
    const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host)
    return !!v4 && Number(v4[1]) === 100 && Number(v4[2]) >= 64 && Number(v4[2]) <= 127
  } catch {
    return false
  }
}

const unreachableText = (root: string, why: string) => `Nothing answered at ${root} (${why}). Is the server running and is the address right? ${LISTEN_HINT}`

/**
 * Look at one address: does it answer, what is it, which models does it have. The key and the CA
 * are used for this address only. Never throws.
 */
export async function checkRemote(input: string, opts: { key?: string; tls?: ProviderTls; providerID?: string; timeoutMs?: number } = {}): Promise<RemoteCheck> {
  const parsed = parseHost(input)
  if (!parsed.ok) return { ok: false, url: redact(input), problem: { code: "bad-url", message: parsed.message } }
  const { root } = parsed
  const timeoutMs = opts.timeoutMs ?? 4000
  if (opts.key) registerSecret(opts.key)
  if (opts.key && !parsed.secure && !privateHost(root)) {
    return { ok: false, url: root, problem: { code: "key-over-plain-http", message: `${root} is not on a private network and is not HTTPS: a key would travel unencrypted. Use https:// or a VPN address.` } }
  }

  const started = performance.now()
  const root_ = await probe(root + "/", timeoutMs, opts.key ? { headers: { authorization: `Bearer ${opts.key}` } } : {}, { tls: opts.tls })
  const latencyMs = Math.round(performance.now() - started)

  if (root_.status === 0) {
    const err: any = root_.error
    const text = String(err?.message ?? err ?? "")
    const tls = describeTlsError(root_.error, { providerID: opts.providerID ?? "<id>", host: parsed.host, hasCA: !!opts.tls })
    if (tls) return { ok: false, url: root, problem: { code: "tls", message: tls } }
    if (tlsErrorCode(root_.error)) return { ok: false, url: root, problem: { code: "tls", message: redact(`The TLS handshake with ${parsed.host} failed (${tlsErrorCode(root_.error)}).`) } }
    if (/redirect/i.test(text)) return { ok: false, url: root, problem: { code: "redirect", message: `${root} redirected the request. Redirects are refused so a key never follows one; give the final address.` } }
    if (err?.name === "TimeoutError" || /timed? ?out/i.test(text)) return { ok: false, url: root, problem: { code: "timeout", message: unreachableText(root, "no answer within the time limit") } }
    return { ok: false, url: root, problem: { code: "unreachable", message: unreachableText(root, "connection refused or no route") } }
  }

  const access: ServerAccess = { tls: opts.tls, key: opts.key }
  const server = await identify(root, timeoutMs, access)
  if (server) return { ok: true, url: root, latencyMs, server }

  // reachable but not identified
  if (root_.status === 401 || root_.status === 403) {
    return {
      ok: false,
      url: root,
      latencyMs,
      problem: opts.key
        ? { code: "key-refused", message: `${root} refused the key (HTTP ${root_.status}). Check that it is the key for this server.` }
        : { code: "needs-key", message: `${root} needs an API key (HTTP ${root_.status}). Add one with --key or the key prompt.` },
    }
  }
  const models = await probe(`${root}/v1/models`, timeoutMs, opts.key ? { headers: { authorization: `Bearer ${opts.key}` } } : {}, { tls: opts.tls })
  if (models.status === 401 || models.status === 403) {
    return {
      ok: false,
      url: root,
      latencyMs,
      problem: opts.key
        ? { code: "key-refused", message: `${root} refused the key (HTTP ${models.status}). Check that it is the key for this server.` }
        : { code: "needs-key", message: `${root} needs an API key (HTTP ${models.status}). Add one with --key or the key prompt.` },
    }
  }
  return {
    ok: false,
    url: root,
    latencyMs,
    problem: { code: "not-a-model-server", message: `${root} answers, but it does not look like Ollama, LM Studio, llama.cpp, vLLM or an OpenAI-compatible server (no /v1/models).` },
  }
}

/** Which kind of server answers at `root`. The specific kinds are tried before the generic one. */
async function identify(root: string, timeoutMs: number, access: ServerAccess): Promise<RemoteServer | undefined> {
  const [llama, ollama, vllm, lmstudioProbe] = await Promise.all([
    detectLlamaCpp(root, timeoutMs, access.key, undefined, access.tls),
    detectOllama(root, timeoutMs, access),
    detectVLLM(root, timeoutMs, access),
    probe(`${root}/api/v0/models`, timeoutMs, access.key ? { headers: { authorization: `Bearer ${access.key}` } } : {}, { tls: access.tls }),
  ])
  if (llama) return fromLocal("llamacpp", llama)
  if (ollama) return fromLocal("ollama", ollama)
  if (vllm) return fromLocal("vllm", vllm)
  if (lmstudioProbe.ok && Array.isArray(lmstudioProbe.json?.data)) {
    const lm = await detectLMStudio(root, timeoutMs, access)
    if (lm) return fromLocal("lmstudio", lm)
  }
  const generic = await discoverOpenAIModels(`${root}/v1`, {}, access.key, timeoutMs, access.tls)
  if (generic.length) return { kind: "openai", name: KIND_NAME.openai, protocol: "openai", baseURL: `${root}/v1`, models: generic }
  return undefined
}

function fromLocal(kind: ServerKind, server: { name: string; protocol: "ollama" | "openai"; baseURL: string; models: Record<string, DetectedModel>; opereta?: OperetaInfo }): RemoteServer {
  return {
    kind,
    name: server.opereta ? "Opereta" : KIND_NAME[kind],
    protocol: server.protocol,
    baseURL: server.baseURL,
    models: Object.values(server.models),
    ...(server.opereta ? { opereta: server.opereta } : {}),
  }
}

// ---- network scan -------------------------------------------------------------------------------

export interface LanInterface {
  name: string
  address: string
  /** The /24 around it, without this machine's own address. */
  hosts: string[]
}

/** Private IPv4 addresses of this machine and the /24 each one sits in. Larger networks are not walked. */
export function lanInterfaces(interfaces: ReturnType<typeof os.networkInterfaces> = os.networkInterfaces()): LanInterface[] {
  const out: LanInterface[] = []
  const seen = new Set<string>()
  for (const [name, rows] of Object.entries(interfaces)) {
    for (const row of rows ?? []) {
      if (row.family !== "IPv4" || row.internal) continue
      const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(row.address)
      if (!m) continue
      const a = Number(m[1])
      const b = Number(m[2])
      const rfc1918 = a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
      if (!rfc1918) continue
      const prefix = `${m[1]}.${m[2]}.${m[3]}`
      if (seen.has(prefix)) continue
      seen.add(prefix)
      const hosts: string[] = []
      for (let i = 1; i <= 254; i++) if (i !== Number(m[4])) hosts.push(`${prefix}.${i}`)
      out.push({ name, address: row.address, hosts })
    }
  }
  return out
}

/** Whether a TCP connection to host:port opens within the time limit. */
function portOpen(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    const done = (open: boolean) => {
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once("connect", () => done(true))
    socket.once("error", () => done(false))
  })
}

export interface ScanResult {
  /** Addresses tried (hosts x ports). */
  tried: number
  durationMs: number
  interfaces: { name: string; address: string }[]
  found: RemoteCheck[]
  /** Answered, but wants a key. The scan never sends one. */
  needKey: RemoteCheck[]
}

/**
 * Look for model servers on the local network. Runs only when asked for. It sends no key and no
 * file: one TCP connect per address and port, then one unauthenticated request to each open one.
 * `hosts` limits it to private IPv4 addresses; anything else is refused.
 */
export async function scanNetwork(opts: { hosts?: string[]; ports?: number[]; timeoutMs?: number; concurrency?: number; signal?: AbortSignal } = {}): Promise<ScanResult> {
  const started = performance.now()
  const interfaces = opts.hosts ? [] : lanInterfaces()
  let hosts = opts.hosts ?? interfaces.flatMap((i) => i.hosts)
  if (opts.hosts) {
    for (const h of opts.hosts) {
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(h) || !isLocalURL(`http://${h}`)) throw new RangeError(`Only private network addresses can be scanned (got ${redact(h)}).`)
    }
  }
  hosts = [...new Set(hosts)].slice(0, 1024)
  const ports = opts.ports ?? DEFAULT_PORTS.map((p) => p.port)
  const timeoutMs = opts.timeoutMs ?? 500
  const pairs = hosts.flatMap((host) => ports.map((port) => ({ host, port })))
  const open: { host: string; port: number }[] = []
  let next = 0
  const workers = Array.from({ length: Math.min(opts.concurrency ?? 96, pairs.length) }, async () => {
    while (next < pairs.length && !opts.signal?.aborted) {
      const pair = pairs[next++]!
      if (await portOpen(pair.host, pair.port, timeoutMs)) open.push(pair)
    }
  })
  await Promise.all(workers)

  const checks = await Promise.all(open.map((o) => checkRemote(`http://${o.host}:${o.port}`, { timeoutMs: 2500 })))
  return {
    tried: pairs.length,
    durationMs: Math.round(performance.now() - started),
    interfaces: interfaces.map((i) => ({ name: i.name, address: i.address })),
    found: checks.filter((c) => c.ok),
    needKey: checks.filter((c) => c.problem?.code === "needs-key"),
  }
}

// ---- host profiles ------------------------------------------------------------------------------

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/

/** `GPU Box` -> `gpu-box`. */
export function hostID(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
}

export async function listRemoteHosts(): Promise<RemoteHost[]> {
  const config = await getConfig()
  const providers = await allProviders()
  const rows: RemoteHost[] = []
  for (const [id, provider] of Object.entries(config.provider ?? {})) {
    if (provider.remote !== true) continue
    const info = providers[id]
    rows.push({
      id,
      name: provider.name ?? id,
      url: provider.options?.baseURL ?? provider.api ?? "",
      protocol: provider.protocol === "ollama" ? "ollama" : "openai",
      hasKey: !!info?.apiKey,
      hasCA: provider.options?.ca !== undefined,
    })
  }
  return rows
}

export interface AddHostInput {
  name: string
  url: string
  key?: string
  /** PEM file path or inline PEM of the certificate authority the server's certificate must chain to. */
  ca?: string
}

/**
 * Save a host as a provider. The address is checked first with the given key and CA; an address
 * that does not answer is still saved (a GPU box may be asleep) and reported in `check`. A bad
 * address, a key that would travel unencrypted and an unusable CA file are refused.
 */
export async function addRemoteHost(input: AddHostInput): Promise<{ host: RemoteHost; check: RemoteCheck }> {
  const id = hostID(input.name)
  if (!ID.test(id)) throw new Error(`"${input.name}" cannot be turned into a short name (letters, digits and dashes).`)
  const existing = await getConfig()
  if (existing.provider?.[id] && existing.provider[id]!.remote !== true) throw new Error(`"${id}" is already a provider; choose another name.`)
  const known = await allProviders()
  // the live catalog may be unreachable (offline): the ids we ship, the default servers and the
  // hosted providers' own ids stay off limits regardless
  const reserved = new Set([...Object.keys(known), ...Object.keys(await getCatalog()), ...Object.keys(KNOWN_BASE_URLS), "anthropic", "openai", "google", "openrouter", "ollama", "lmstudio", "llamacpp", "vllm"])
  if (reserved.has(id) && existing.provider?.[id]?.remote !== true) throw new Error(`"${id}" is the name of a built-in provider; choose another name.`)

  let tls: ProviderTls | undefined
  let ca = input.ca?.trim() || undefined
  if (ca && !isInlinePEM(ca)) ca = path.resolve(ca)
  if (ca) {
    try {
      tls = (await loadProviderCA(ca, id)).tls
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err))
    }
  }
  const key = input.key?.trim() || undefined
  const check = await checkRemote(input.url, { key, tls, providerID: id })
  const refuse: ProblemCode[] = ["bad-url", "key-over-plain-http", "redirect"]
  if (check.problem && refuse.includes(check.problem.code)) throw new Error(check.problem.message)

  const root = parseHost(input.url)
  if (!root.ok) throw new Error(root.message)
  const protocol = check.server?.protocol ?? "openai"
  const baseURL = check.server?.baseURL ?? (protocol === "ollama" ? root.root : `${root.root}/v1`)
  const name = input.name.trim()

  await editGlobalConfig((current) => {
    const providers = { ...(current.provider ?? {}) }
    providers[id] = { name, protocol, remote: true, options: { baseURL, ...(ca ? { ca } : {}) } }
    return { ...current, provider: providers }
  })
  if (key) await setCredential(id, { type: "api", key })
  else await removeCredential(id)
  resetProviders()
  return { host: { id, name, url: baseURL, protocol, hasKey: !!key, hasCA: !!ca }, check }
}

export async function removeRemoteHost(id: string): Promise<boolean> {
  const config = await getConfig()
  if (config.provider?.[id]?.remote !== true) return false
  await editGlobalConfig((current) => {
    const providers = { ...(current.provider ?? {}) }
    delete providers[id]
    const { provider: _old, ...rest } = current
    return Object.keys(providers).length === 0 ? rest : { ...rest, provider: providers }
  })
  await removeCredential(id)
  resetProviders()
  return true
}
