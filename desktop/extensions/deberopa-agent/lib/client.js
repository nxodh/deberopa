"use strict"
// HTTP and server-sent-event client for `deberopa serve`. No dependency on VS Code, so it can be tested directly.

class ApiError extends Error {
  constructor(status, message) {
    super(message)
    this.name = "ApiError"
    this.status = status
  }
}

/** Splits an SSE byte stream into JSON payloads (`data:` lines); comment lines are ignored. */
function createSseParser(onEvent) {
  let buffer = ""
  return (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const block = buffer.slice(0, index)
      buffer = buffer.slice(index).replace(/^\r?\n\r?\n/, "")
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n")
      if (data === "") continue
      try {
        onEvent(JSON.parse(data))
      } catch {
        // a malformed payload must not stop the stream
      }
    }
  }
}

class DeberopaClient {
  /** @param {{ baseUrl: string, password?: string }} options */
  constructor(options) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "")
    this.password = options.password
  }

  headers(extra) {
    const headers = { accept: "application/json", ...extra }
    if (this.password) headers.authorization = "Basic " + Buffer.from(`deberopa:${this.password}`).toString("base64")
    return headers
  }

  async request(method, path, body, signal) {
    const response = await fetch(this.baseUrl + path, {
      method,
      signal,
      redirect: "error",
      headers: this.headers(body === undefined ? {} : { "content-type": "application/json" }),
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    let data
    try {
      data = text === "" ? null : JSON.parse(text)
    } catch {
      data = text
    }
    if (!response.ok) throw new ApiError(response.status, (data && data.error) || (typeof data === "string" && data) || `HTTP ${response.status}`)
    return data
  }

  health() { return this.request("GET", "/health") }
  project() { return this.request("GET", "/project") }
  agents() { return this.request("GET", "/agent") }
  providers() { return this.request("GET", "/provider") }
  local() { return this.request("GET", "/local") }
  toolcheck(model) { return this.request("POST", "/local/toolcheck", { model }) }
  slots(provider) { return this.request("GET", "/local/slots?provider=" + encodeURIComponent(provider)) }
  pull(provider, model) { return this.request("POST", "/local/pull", { provider, model }) }
  commands() { return this.request("GET", "/command") }
  sessions() { return this.request("GET", "/session") }
  createSession(title) { return this.request("POST", "/session", title ? { title } : {}) }
  session(id) { return this.request("GET", `/session/${encodeURIComponent(id)}`) }
  messages(id) { return this.request("GET", `/session/${encodeURIComponent(id)}/message`) }
  prompt(id, text, options = {}) {
    return this.request("POST", `/session/${encodeURIComponent(id)}/prompt_async`, { text, ...options })
  }
  abort(id) { return this.request("POST", `/session/${encodeURIComponent(id)}/abort`, {}) }
  compact(id) { return this.request("POST", `/session/${encodeURIComponent(id)}/compact`, {}) }
  revert(id, messageID) { return this.request("POST", `/session/${encodeURIComponent(id)}/revert`, { messageID }) }
  unrevert(id) { return this.request("POST", `/session/${encodeURIComponent(id)}/unrevert`, {}) }
  fork(id, messageID) { return this.request("POST", `/session/${encodeURIComponent(id)}/fork`, messageID ? { messageID } : {}) }
  permissions() { return this.request("GET", "/permission") }
  replyPermission(id, reply, message) {
    return this.request("POST", `/permission/${encodeURIComponent(id)}`, message ? { reply, message } : { reply })
  }
  findFile(query, limit = 20) {
    return this.request("GET", `/find/file?query=${encodeURIComponent(query)}&limit=${limit}`)
  }

  /**
   * Streams every event until `signal` aborts or the connection ends.
   * Resolves when the stream closes; rejects on a connection error.
   */
  async events(onEvent, signal) {
    const response = await fetch(this.baseUrl + "/event", { signal, redirect: "error", headers: this.headers({ accept: "text/event-stream" }) })
    if (!response.ok || !response.body) throw new ApiError(response.status, `event stream: HTTP ${response.status}`)
    const decoder = new TextDecoder()
    const feed = createSseParser(onEvent)
    const reader = response.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        feed(decoder.decode(value, { stream: true }))
      }
    } finally {
      try { reader.releaseLock() } catch {}
    }
  }
}

module.exports = { ApiError, DeberopaClient, createSseParser }
