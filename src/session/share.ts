import { randomBytes } from "node:crypto"
import { exportMarkdown } from "./export"
import { redact, registerSecret } from "../util/redact"

const escape = (text: string) => text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!)
const POLICY = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

export async function shareHTML(sessionID: string): Promise<string> {
  // No tool output, reasoning, synthetic file contents, or attachment payloads.
  const text = redact(await exportMarkdown(sessionID, { tools: false, thinking: false }))
    .replace(/^Session `[^`]+` · created .* · updated .*\n/m, "")
    .replace(/\b(password|passwd|api[_-]?key|(?:access[_-]?)?token|secret)\s*[:=]\s*["']?[^\s"'`<]+/gi, "$1=[redacted]")
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>Vedecaps conversation</title><style>body{max-width:72rem;margin:2rem auto;padding:0 1rem;font-family:monospace}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>Vedecaps conversation</h1><pre>${escape(text)}</pre></html>`
}

/** A separate read-only viewer: it exposes none of the agent HTTP API. */
export function startShareViewer(html: string, options: { hostname?: string; port?: number; ttl?: number } = {}) {
  const hostname = options.hostname ?? "127.0.0.1"
  if (!["127.0.0.1", "localhost", "::1"].includes(hostname)) throw new Error("The viewer only binds to loopback. Use an HTTPS reverse proxy for remote sharing.")
  const ttl = options.ttl ?? 3600
  if (!Number.isFinite(ttl) || ttl < 1 || ttl > 86400) throw new Error("Sharing expires after 1 to 86400 seconds")
  const token = randomBytes(32).toString("base64url")
  registerSecret(token)
  const expires = Date.now() + ttl * 1000
  const server = Bun.serve({
    hostname, port: options.port ?? 0,
    fetch(req) {
      if (req.method !== "GET" || new URL(req.url).pathname !== "/" + token || Date.now() >= expires) return new Response("Not found", { status: 404 })
      return new Response(html, { headers: {
        "content-type": "text/html; charset=utf-8", "content-security-policy": POLICY,
        "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-robots-tag": "noindex, nofollow",
      } })
    },
  })
  let finish!: () => void
  const closed = new Promise<void>((resolve) => { finish = resolve })
  let timer: ReturnType<typeof setTimeout>
  const close = () => { clearTimeout(timer); server.stop(true); finish() }
  timer = setTimeout(close, ttl * 1000)
  timer.unref?.()
  return { url: `http://${hostname === "::1" ? "[::1]" : hostname}:${server.port}/${token}`, close, closed }
}
