import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { X509Certificate } from "node:crypto"
import { redact } from "../util/redact"

/**
 * Per-provider trust: `provider.<id>.options.ca` names the certificate authority a server's
 * certificate must chain to. Measured with Bun 1.4: `tls.ca` REPLACES the system trust store for
 * that connection, so a provider that sets it trusts only those CAs. There is deliberately no way
 * to turn certificate or host-name verification off.
 */
export interface ProviderTls {
  /** PEM text of every trusted CA certificate. */
  ca: string[]
}

export interface CaSource {
  /** File name, or "inline PEM". Never the certificate itself. */
  label: string
  /** SHA-256 of each certificate in the source, `AA:BB:...` upper case. */
  fingerprints: string[]
  subjects: string[]
}

export class TlsConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TlsConfigError"
  }
}

const BEGIN = "-----BEGIN CERTIFICATE-----"
const MAX_SOURCES = 8
const MAX_BYTES = 1024 * 1024

/** PEM text rather than a path: no file name contains a PEM header. Text before the header (a comment line) is fine. */
export const isInlinePEM = (value: string) => /-----BEGIN [A-Z0-9 ]+-----/.test(value)

/** `~` and relative paths made absolute. Inline PEM text is left alone. `base` is the folder relative paths hang off. */
export function resolveCaPath(entry: string, base: string): string {
  if (isInlinePEM(entry)) return entry
  const home = os.homedir()
  if (entry === "~") return home
  if (entry.startsWith("~/") || entry.startsWith("~\\")) return path.join(home, entry.slice(2))
  return path.isAbsolute(entry) ? entry : path.resolve(base, entry)
}

/**
 * Make `options.ca` paths in a parsed config absolute, relative to the file they were written in.
 * Anything that is not a string is left as it is so the provider can report it properly later.
 */
export function resolveConfigCaPaths<T extends { provider?: Record<string, { options?: Record<string, any> } | undefined> }>(config: T, base: string): T {
  for (const provider of Object.values(config.provider ?? {})) {
    const ca = provider?.options?.ca
    if (typeof ca === "string") provider!.options!.ca = resolveCaPath(ca, base)
    else if (Array.isArray(ca)) provider!.options!.ca = ca.map((c) => (typeof c === "string" ? resolveCaPath(c, base) : c))
  }
  return config
}

function describe(pem: string, label: string): CaSource {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? []
  if (blocks.length === 0) throw new TlsConfigError(`${label} contains no certificate (expected a PEM block starting with ${BEGIN})`)
  const fingerprints: string[] = []
  const subjects: string[] = []
  for (const block of blocks) {
    try {
      const cert = new X509Certificate(block)
      fingerprints.push(cert.fingerprint256.toUpperCase())
      subjects.push(cert.subject.replace(/\n/g, ", "))
    } catch {
      throw new TlsConfigError(`${label} has a certificate that cannot be read (the PEM is damaged or not X.509)`)
    }
  }
  return { label, fingerprints, subjects }
}

/**
 * Read and check the trusted CAs of one provider. Throws `TlsConfigError` with a sentence the
 * user can act on. The caller makes the provider unusable on error: falling back to the system
 * store would silently trust more than the user asked for.
 */
export async function loadProviderCA(raw: unknown, providerID: string): Promise<{ tls: ProviderTls; sources: CaSource[] }> {
  const entries = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : undefined
  const where = `provider.${providerID}.options.ca`
  if (!entries || entries.length === 0 || entries.some((e) => typeof e !== "string" || e.trim() === "")) {
    throw new TlsConfigError(`${where} must be a path to a PEM file (or a list of paths)`)
  }
  if (entries.length > MAX_SOURCES) throw new TlsConfigError(`${where} lists more than ${MAX_SOURCES} certificate sources`)

  const ca: string[] = []
  const sources: CaSource[] = []
  for (const entry of entries as string[]) {
    let pem: string
    let label: string
    if (isInlinePEM(entry)) {
      pem = entry
      label = "inline PEM"
    } else {
      label = path.basename(entry)
      try {
        const stat = await fs.stat(entry)
        if (!stat.isFile()) throw new Error("not a file")
        if (stat.size > MAX_BYTES) throw new Error("larger than 1 MB")
        pem = await fs.readFile(entry, "utf8")
      } catch (err) {
        const reason = err instanceof Error ? ((err as NodeJS.ErrnoException).code === "ENOENT" ? "no such file" : err.message) : String(err)
        throw new TlsConfigError(`${where}: cannot read ${entry} (${reason}). The provider is not used until this is fixed; it does not fall back to the system certificate store.`)
      }
    }
    if (/PRIVATE KEY-----/.test(pem)) {
      throw new TlsConfigError(`${where}: ${label} contains a private key. Give only the CA certificate, and keep that key out of this file.`)
    }
    sources.push(describe(pem, label))
    ca.push(pem)
  }
  return { tls: { ca }, sources }
}

/** The extra `fetch` option for a provider with its own CA. Spread it into any request to that provider. */
export function tlsInit(tls: ProviderTls | undefined): Record<string, unknown> {
  return tls ? { tls: { ca: tls.ca } } : {}
}

/** The OpenSSL error code behind a failed fetch, wherever Bun and the SDKs nest it. */
export function tlsErrorCode(err: unknown): string | undefined {
  let cursor: any = err
  for (let i = 0; i < 4 && cursor; i++) {
    const code = typeof cursor.code === "string" ? cursor.code : undefined
    if (code && TLS_CODES.has(code)) return code
    cursor = cursor.cause
  }
  return undefined
}

const UNTRUSTED = ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "UNABLE_TO_GET_ISSUER_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT"]
const TLS_CODES = new Set([...UNTRUSTED, "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "PERMITTED_VIOLATION", "UNSUPPORTED_CONSTRAINT_TYPE", "CERT_REVOKED", "ERR_TLS_HANDSHAKE_TIMEOUT"])

/**
 * A fix-it sentence for a certificate failure, or undefined when this is not one (the caller then
 * keeps the original message: a wrong guess is worse than the raw error).
 */
export function describeTlsError(err: unknown, ctx: { providerID: string; host: string; hasCA: boolean }): string | undefined {
  const code = tlsErrorCode(err)
  if (!code) return undefined
  const key = `provider.${ctx.providerID}.options.ca`
  let text: string
  if (UNTRUSTED.includes(code)) {
    text = ctx.hasCA
      ? `The certificate of ${ctx.host} is not signed by a CA listed in ${key}. Check that the file is the CA of that server (for Diparnux: \`diparnux tls ca\`).`
      : `The certificate of ${ctx.host} is not trusted. Set ${key} to the CA file of that server (for Diparnux: \`diparnux tls ca\`).`
  } else if (code === "ERR_TLS_CERT_ALTNAME_INVALID") {
    text = `The certificate does not cover ${ctx.host}. Connect with a name or address the certificate lists (for Diparnux: see \`diparnux tls status\`).`
  } else if (code === "CERT_HAS_EXPIRED") {
    text = `The certificate of ${ctx.host} has expired. Renew it on the server (for Diparnux: \`diparnux tls renew\`) and check the clock on both computers.`
  } else if (code === "CERT_NOT_YET_VALID") {
    text = `The certificate of ${ctx.host} is not valid yet. Check the clock on both computers.`
  } else if (code === "PERMITTED_VIOLATION") {
    text = `The certificate of ${ctx.host} names something its CA is not allowed to issue for (a name constraint is violated). Ask for a certificate within the CA's limits.`
  } else if (code === "UNSUPPORTED_CONSTRAINT_TYPE") {
    text = `This client cannot verify IP-address name constraints in the CA of ${ctx.host}. Use a CA whose name constraints are DNS names only, or a certificate without IP address names.`
  } else if (code === "CERT_REVOKED") {
    text = `The certificate of ${ctx.host} has been revoked.`
  } else {
    text = `The TLS handshake with ${ctx.host} did not finish in time.`
  }
  return redact(`${text} (${code})`)
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
