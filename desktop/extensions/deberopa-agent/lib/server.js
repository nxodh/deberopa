"use strict"
// Starts and supervises `deberopa serve` for one workspace folder.
const { spawn } = require("node:child_process")
const { randomBytes } = require("node:crypto")
const { existsSync } = require("node:fs")
const path = require("node:path")

const LISTENING = /deberopa server listening on (http:\/\/\S+)/

/** The executable: the user's setting, then the copy shipped next to the app, then PATH. */
function resolveCommand({ configured, appRoot, platform = process.platform }) {
  if (configured && configured.trim() !== "") return configured.trim()
  const exe = platform === "win32" ? "deberopa.exe" : "deberopa"
  if (appRoot) {
    const bundled = path.join(appRoot, "..", "deberopa", exe)
    if (existsSync(bundled)) return bundled
  }
  return "deberopa"
}

/**
 * @param {{ command: string, prefixArgs?: string[], args?: string[], directory: string, env?: NodeJS.ProcessEnv, timeoutMs?: number }} options
 * @returns {Promise<{ baseUrl: string, password: string, stop: () => void, exited: Promise<number|null> }>}
 */
function startServer(options) {
  const password = randomBytes(24).toString("hex")
  const args = [...(options.prefixArgs ?? []), "serve", "--port", "0", "--dir", options.directory, ...(options.args ?? [])]
  return new Promise((resolve, reject) => {
    let settled = false
    const child = spawn(options.command, args, {
      cwd: options.directory,
      env: { ...process.env, ...options.env, DEBEROPA_SERVER_PASSWORD: password },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    let stderr = ""
    let out = ""
    const exited = new Promise((done) => child.once("exit", (code) => done(code)))
    const fail = (message) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill() } catch {}
      reject(new Error(message))
    }
    const timer = setTimeout(() => fail("The Deberopa server did not report its address in time."), options.timeoutMs ?? 30_000)
    child.once("error", (err) => fail(`Could not start "${options.command}": ${err.message}`))
    child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-4000) })
    child.stdout.on("data", (d) => {
      out += d
      const match = LISTENING.exec(out)
      if (match && !settled) {
        settled = true
        clearTimeout(timer)
        resolve({ baseUrl: match[1], password, exited, stop: () => { try { child.kill() } catch {} } })
      }
    })
    child.once("exit", (code) => fail(`The Deberopa server exited with code ${code}.${stderr ? "\n" + stderr.trim() : ""}`))
  })
}

module.exports = { resolveCommand, startServer }
