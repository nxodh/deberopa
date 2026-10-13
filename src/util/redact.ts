/**
 * Keeps credentials out of logs, error messages, exports and API responses.
 * Two layers: well-known key shapes, plus the exact secrets this process has been given.
 */
const KEY_SHAPES: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /AIza[0-9A-Za-z_-]{30,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[abprs]-[0-9A-Za-z-]{10,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
]

const known = new Set<string>()

/** Register a secret value (an API key from config, env or the credential store) to be scrubbed verbatim. */
export function registerSecret(value: string | undefined) {
  if (value && value.length >= 8) known.add(value)
}

export function redact(text: string): string {
  let out = text
  for (const secret of known) if (out.includes(secret)) out = out.split(secret).join("[redacted]")
  for (const re of KEY_SHAPES) out = out.replace(re, "[redacted]")
  return out
}

/** `sk-ab…wxyz`: enough to recognise a key, never enough to use it. */
export function maskKey(key: string): string {
  if (key.length <= 12) return "*".repeat(key.length)
  return `${key.slice(0, 3)}…${key.slice(-4)}`
}

export const SECRET_KEY = /^(apikey|api_key|token|secret|password|authorization|access|refresh|key)$|(?:^|[_-])(?:api[_-]?key|token|secret|password|authorization)(?:$|[_-])/i

/** Register credential fields and secret URL parameters before anything logs the configuration. */
export function registerConfigSecrets(value: unknown, field = "") {
  if (typeof value === "string") {
    if (SECRET_KEY.test(field)) {
      registerSecret(value)
      registerSecret(value.replace(/^Bearer\s+/i, ""))
    }
    if (/^https?:\/\//i.test(value)) {
      try {
        const url = new URL(value)
        registerSecret(url.password)
        for (const [key, item] of url.searchParams) if (SECRET_KEY.test(key)) registerSecret(item)
      } catch {}
    }
  } else if (Array.isArray(value)) {
    for (const item of value) registerConfigSecrets(item, field)
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (field === "headers" && typeof item === "string") registerSecret(item)
      registerConfigSecrets(item, key)
    }
  }
}

/** Deep copy with credential-looking fields masked (used for config dumps and API responses). */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) && typeof v === "string" ? maskKey(v) : redactDeep(v)
    }
    return out as T
  }
  return value
}
