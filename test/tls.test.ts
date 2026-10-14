import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { loadConfig, resetConfig } from "../src/config/config"
import { stripUntrusted } from "../src/config/trust"
import { initProject } from "../src/project"
import { setCatalog } from "../src/provider/models"
import { allProviders, availableProviders, getModel, resetProviders } from "../src/provider/provider"
import { generateText, streamModel } from "../src/provider/stream"
import { setDefaultEndpoints, probe } from "../src/provider/local"
import { checkToolCalling } from "../src/provider/toolcheck"
import { describeTlsError, loadProviderCA, resolveCaPath, tlsErrorCode, TlsConfigError } from "../src/provider/tls"
import { runLocalDebug } from "../src/cli/commands/local-debug"
import type { StreamEvent } from "../src/provider/types"
import { endProject, resetAll, tmpDir, useProject } from "./helpers"

/**
 * Certificates are throw-away fixtures (test/fixtures/tls/README.md). Servers use Bun.serve with
 * `tls`, so these tests run the same TLS stack the client uses on every platform.
 */
const FIX = path.join(import.meta.dir, "fixtures", "tls")
const file = (name: string) => path.join(FIX, name)
const pem = (name: string) => fs.readFileSync(file(name), "utf8")
const KEY = "sk-test-not-a-real-key"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const sse = (text: string) =>
  [
    { choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
    ...(text.match(/.{1,4}/gs) ?? []).map((p) => ({ choices: [{ index: 0, delta: { content: p }, finish_reason: null }] })),
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } },
  ]
    .map((e) => `data: ${JSON.stringify(e)}\n\n`)
    .join("") + "data: [DONE]\n\n"

interface Seen {
  path: string
  auth?: string
}
interface Backend {
  port: number
  seen: Seen[]
  inflight: number
  maxInflight: number
  stop(): void
}

/** An HTTPS (or plain, with `cert` undefined) model server. */
function backend(cert: string | undefined, opts: { delayMs?: number; redirectTo?: string; info?: unknown } = {}): Backend {
  const state: Backend = { port: 0, seen: [], inflight: 0, maxInflight: 0, stop: () => {} }
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 30,
    ...(cert ? { tls: { cert: pem(`${cert}.pem`), key: pem(`${cert}-key.pem`) } } : {}),
    async fetch(req) {
      const url = new URL(req.url)
      state.seen.push({ path: url.pathname, auth: req.headers.get("authorization") ?? undefined })
      if (opts.redirectTo) return Response.redirect(opts.redirectTo, 301)
      if (url.pathname === "/diparnux/info") return opts.info === undefined ? new Response("no", { status: 404 }) : Response.json(opts.info, { headers: { "x-diparnux": "0.5.4" } })
      if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "m" }] })
      if (url.pathname === "/v1/chat/completions") {
        const body: any = await req.json().catch(() => ({}))
        state.inflight++
        state.maxInflight = Math.max(state.maxInflight, state.inflight)
        try {
          if (opts.delayMs) await sleep(opts.delayMs)
          if (body.stream === false) {
            return Response.json({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "get_time", arguments: '{"city":"Paris"}' } }] } }] })
          }
          return new Response(sse("secure pong"), { headers: { "content-type": "text/event-stream" } })
        } finally {
          state.inflight--
        }
      }
      return new Response("not found", { status: 404 })
    },
  })
  state.port = server.port!
  state.stop = () => void server.stop(true)
  return state
}

const servers: Backend[] = []
const start = (...args: Parameters<typeof backend>) => {
  const b = backend(...args)
  servers.push(b)
  return b
}
const chatCount = (b: Backend) => b.seen.filter((s) => s.path.endsWith("/chat/completions")).length

let dir: string
const savedEnv = { ...process.env }

beforeAll(() => {
  dir = tmpDir("vdc-tls-")
  fs.mkdirSync(path.join(dir, ".git"))
})
afterAll(() => {
  endProject()
  for (const k of ["VEDECAPS_DISABLE_LOCAL_DETECT", "VEDECAPS_TRUST_PROJECT", "VEDECAPS_CONFIG"]) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})
beforeEach(() => {
  process.env.VEDECAPS_DISABLE_LOCAL_DETECT = "1"
  delete process.env.VEDECAPS_TRUST_PROJECT
  delete process.env.VEDECAPS_CONFIG
})
afterEach(() => {
  while (servers.length) servers.pop()!.stop()
  setDefaultEndpoints(undefined)
})

const providerConfig = (port: number, ca?: unknown, extra: Record<string, unknown> = {}) => ({
  provider: { tlsp: { name: "TLS Test", options: { baseURL: `https://127.0.0.1:${port}/v1`, apiKey: KEY, ...(ca === undefined ? {} : { ca }), ...extra }, models: { m: { name: "M" } } } },
})

async function ask(): Promise<{ text: string; error?: Error }> {
  const { provider, model } = await getModel("tlsp", "m")
  let text = ""
  try {
    for await (const e of streamModel({ provider, model, system: [], messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }], tools: [] }) as AsyncIterable<StreamEvent>) {
      if (e.type === "text-delta") text += e.text
    }
    return { text }
  } catch (error) {
    return { text, error: error as Error }
  }
}

// ---- TC1 ----------------------------------------------------------------------------------

test("TC1 a server whose certificate chains to options.ca answers, with the stream intact", async () => {
  const s = start("server")
  useProject(dir, providerConfig(s.port, file("ca.pem")))
  const r = await ask()
  expect(r.error).toBeUndefined()
  expect(r.text).toBe("secure pong")
  expect(s.seen.find((x) => x.path.endsWith("/chat/completions"))?.auth).toBe(`Bearer ${KEY}`)
  const p = (await allProviders()).tlsp!
  expect(p.tls?.ca).toHaveLength(1)
  expect(p.tlsSources?.[0]?.label).toBe("ca.pem")
  expect(p.tlsSources?.[0]?.fingerprints[0]).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
})

// ---- TC2–TC5: refusals --------------------------------------------------------------------

test("TC2 without options.ca a private CA is refused, with guidance, and the request never reaches the server", async () => {
  const s = start("server")
  useProject(dir, providerConfig(s.port))
  const r = await ask()
  expect(r.error?.message).toContain("is not trusted")
  expect(r.error?.message).toContain("provider.tlsp.options.ca")
  expect(r.error?.message).toContain("diparnux tls ca")
  expect(s.seen).toHaveLength(0)
  expect(r.error?.message).not.toContain(KEY)
})

test("TC3 a CA that did not sign the server certificate is refused", async () => {
  const s = start("server")
  useProject(dir, providerConfig(s.port, file("other-ca.pem")))
  const r = await ask()
  expect(r.error?.message).toContain("not signed by a CA listed in provider.tlsp.options.ca")
  expect(s.seen).toHaveLength(0)
})

test("TC4 a certificate for another name is refused and says what to do", async () => {
  const s = start("wrongname")
  useProject(dir, providerConfig(s.port, file("ca.pem")))
  const r = await ask()
  expect(r.error?.message).toContain("does not cover 127.0.0.1")
  expect(r.error?.message).toContain("diparnux tls status")
  expect(s.seen).toHaveLength(0)
})

test("TC5 an expired certificate is refused and says how to renew it", async () => {
  const s = start("expired")
  useProject(dir, providerConfig(s.port, file("ca.pem")))
  const r = await ask()
  expect(r.error?.message).toContain("has expired")
  expect(r.error?.message).toContain("diparnux tls renew")
  expect(s.seen).toHaveLength(0)
})

test("a self-signed server certificate is refused unless it is the configured anchor", async () => {
  const s = start("selfsigned")
  useProject(dir, providerConfig(s.port, file("ca.pem")))
  expect((await ask()).error?.message).toMatch(/not (trusted|signed by)/)
  useProject(dir, providerConfig(s.port, file("selfsigned.pem")))
  expect((await ask()).text).toBe("secure pong")
})

test("TLS failures are not retried: they are marked non-retryable", async () => {
  const s = start("server")
  useProject(dir, providerConfig(s.port))
  const r = await ask()
  expect((r.error as any)?.retryable).toBe(false)
})

// ---- TC6: unusable ca ---------------------------------------------------------------------

test("TC6 a missing, non-PEM or key-bearing ca makes the provider unusable, with no fallback", async () => {
  const s = start("server")
  const junk = path.join(dir, "junk.pem")
  fs.writeFileSync(junk, "this is not a certificate\n")
  const withKey = path.join(dir, "with-key.pem")
  fs.writeFileSync(withKey, pem("ca.pem") + pem("ca-key.pem"))

  const cases: [string, string][] = [
    [path.join(dir, "does-not-exist.pem"), "cannot read"],
    [junk, "contains no certificate"],
    [withKey, "contains a private key"],
  ]
  for (const [ca, reason] of cases) {
    useProject(dir, providerConfig(s.port, ca))
    const p = (await allProviders()).tlsp!
    expect(p.problem).toContain(reason)
    expect(p.source).toBe("none")
    expect(p.tls).toBeUndefined()
    expect((await availableProviders()).map((x) => x.id)).not.toContain("tlsp")
    await expect(getModel("tlsp", "m")).rejects.toThrow(reason)
  }
  // the server was never contacted: there is no silent fallback to some other trust store
  expect(s.seen).toHaveLength(0)

  // the message names the setting and says there is no fallback
  useProject(dir, providerConfig(s.port, path.join(dir, "does-not-exist.pem")))
  expect((await allProviders()).tlsp!.problem).toContain("does not fall back")
})

test("loadProviderCA rejects the wrong shapes before touching the disk", async () => {
  for (const bad of [42, "", [], [1], ["  "], { a: 1 }]) {
    await expect(loadProviderCA(bad, "x")).rejects.toBeInstanceOf(TlsConfigError)
  }
  await expect(loadProviderCA(Array.from({ length: 9 }, () => "a.pem"), "x")).rejects.toThrow("more than 8")
})

test("inline PEM text is accepted", async () => {
  const s = start("server")
  useProject(dir, providerConfig(s.port, pem("ca.pem")))
  const p = (await allProviders()).tlsp!
  expect(p.problem).toBeUndefined()
  expect(p.tlsSources?.[0]?.label).toBe("inline PEM")
  expect((await ask()).text).toBe("secure pong")
})

// ---- TC7: where relative paths point -----------------------------------------------------

test("TC7 a relative ca is relative to the config file it came from, whatever the current directory", async () => {
  const root = tmpDir("vdc-tls-rel-")
  fs.mkdirSync(path.join(root, ".git"))
  fs.mkdirSync(path.join(root, "certs"))
  fs.mkdirSync(path.join(root, "sub", "deeper"), { recursive: true })
  fs.copyFileSync(file("ca.pem"), path.join(root, "certs", "ca.pem"))
  const s = start("server")
  fs.writeFileSync(path.join(root, "vedecaps.json"), JSON.stringify(providerConfig(s.port, "certs/ca.pem")))
  process.env.VEDECAPS_TRUST_PROJECT = "1"
  delete process.env.VEDECAPS_CONFIG_CONTENT
  initProject(path.join(root, "sub", "deeper"))
  setCatalog({})
  resetAll()
  const p = (await allProviders()).tlsp!
  expect(p.problem).toBeUndefined()
  expect(p.tlsSources?.[0]?.label).toBe("ca.pem")
  expect((await ask()).text).toBe("secure pong")

  // a file named by VEDECAPS_CONFIG resolves against its own folder
  const elsewhere = tmpDir("vdc-tls-cfg-")
  fs.copyFileSync(file("ca.pem"), path.join(elsewhere, "my-ca.pem"))
  fs.writeFileSync(path.join(elsewhere, "extra.json"), JSON.stringify(providerConfig(s.port, "my-ca.pem")))
  fs.rmSync(path.join(root, "vedecaps.json"))
  process.env.VEDECAPS_CONFIG = path.join(elsewhere, "extra.json")
  initProject(root)
  resetAll()
  expect((await allProviders()).tlsp!.problem).toBeUndefined()
  expect((await ask()).text).toBe("secure pong")
})

test("VEDECAPS_CONFIG_CONTENT resolves a relative ca against the current directory", async () => {
  const root = tmpDir("vdc-tls-env-")
  fs.mkdirSync(path.join(root, ".git"))
  fs.copyFileSync(file("ca.pem"), path.join(root, "ca.pem"))
  const s = start("server")
  useProject(root, providerConfig(s.port, "ca.pem"))
  expect((await allProviders()).tlsp!.problem).toBeUndefined()
  expect((await ask()).text).toBe("secure pong")
})

test("resolveCaPath: ~ is the home directory, absolute stays, inline PEM is untouched", () => {
  expect(resolveCaPath("~/certs/ca.pem", "/base")).toBe(path.join(os.homedir(), "certs/ca.pem"))
  expect(resolveCaPath("~", "/base")).toBe(os.homedir())
  const abs = path.resolve("/etc/ssl/ca.pem")
  expect(resolveCaPath(abs, "/base")).toBe(abs)
  expect(resolveCaPath("ca.pem", path.resolve("/base"))).toBe(path.resolve("/base", "ca.pem"))
  expect(resolveCaPath("-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----", "/base")).toStartWith("-----BEGIN")
})

// ---- TC8: untrusted projects ------------------------------------------------------------

test("TC8 a project that is not trusted cannot choose the CA; the global config's ca is kept", async () => {
  const root = tmpDir("vdc-tls-trust-")
  fs.mkdirSync(path.join(root, ".git"))
  fs.writeFileSync(path.join(root, "vedecaps.json"), JSON.stringify({ provider: { evil: { name: "Evil", options: { ca: "attacker-ca.pem", timeout: 5000 } } } }))
  const globalDir = tmpDir("vdc-tls-global-")
  fs.writeFileSync(path.join(globalDir, "global.json"), JSON.stringify({ provider: { mine: { options: { ca: "my-ca.pem" } } } }))
  process.env.VEDECAPS_CONFIG = path.join(globalDir, "global.json")
  delete process.env.VEDECAPS_CONFIG_CONTENT
  delete process.env.VEDECAPS_TRUST_PROJECT
  initProject(root)
  resetConfig()

  const loaded = await loadConfig()
  expect(loaded.trusted).toBe(false)
  expect(loaded.config.provider?.evil?.options?.ca).toBeUndefined()
  expect(loaded.config.provider?.evil?.options?.timeout).toBe(5000)
  expect(loaded.blocked.join("\n")).toContain("provider.evil.ca (decides which servers are trusted)")
  expect(loaded.config.provider?.mine?.options?.ca).toBe(path.join(globalDir, "my-ca.pem"))
})

test("stripUntrusted removes options.ca (string or list) and reports it, without touching its input", () => {
  const input = { provider: { a: { options: { ca: ["x.pem", "y.pem"], baseURL: "https://x" } }, b: { options: { ca: "z.pem" } } } }
  const { config, blocked } = stripUntrusted(input as any)
  expect(config.provider!.a!.options!.ca).toBeUndefined()
  expect(config.provider!.b!.options!.ca).toBeUndefined()
  expect(blocked).toContain("provider.a.ca (decides which servers are trusted)")
  expect(blocked).toContain("provider.b.ca (decides which servers are trusted)")
  expect(input.provider.a.options.ca).toEqual(["x.pem", "y.pem"])
})

// ---- TC9 ---------------------------------------------------------------------------------

test("TC9 a list of CAs trusts a server signed by either", async () => {
  const a = start("server")
  const b = start("other-server")
  for (const port of [a.port, b.port]) {
    useProject(dir, providerConfig(port, [file("other-ca.pem"), file("ca.pem")]))
    expect((await ask()).text).toBe("secure pong")
  }
  // and it still trusts nothing else
  const c = start("selfsigned")
  useProject(dir, providerConfig(c.port, [file("other-ca.pem"), file("ca.pem")]))
  expect((await ask()).error).toBeDefined()
})

// ---- TC10 --------------------------------------------------------------------------------

test("TC10 http -> https redirects are errors: the second request is never made and the key is not sent", async () => {
  const target = start("server")
  const plain = start(undefined, { redirectTo: `https://127.0.0.1:${target.port}/v1/chat/completions` })
  useProject(dir, { provider: { tlsp: { name: "TLS Test", options: { baseURL: `http://127.0.0.1:${plain.port}/v1`, apiKey: KEY, ca: file("ca.pem") }, models: { m: {} } } } })
  const r = await ask()
  expect(r.error).toBeDefined()
  expect(target.seen).toHaveLength(0)
  expect(r.error?.message).not.toContain(KEY)

  const res = await probe(`http://127.0.0.1:${plain.port}/diparnux/info`, 2000, {}, { tls: { ca: [pem("ca.pem")] } })
  expect(res.ok).toBe(false)
  expect(res.status).toBe(0)
  expect(target.seen).toHaveLength(0)
})

// ---- TC11: name constraints -------------------------------------------------------------

test("TC11 a CA limited to DNS names verifies a server that sits inside the limits (IP names on the leaf included)", async () => {
  const s = start("nc-server")
  useProject(dir, providerConfig(s.port, file("nc-ca.pem")))
  expect((await ask()).text).toBe("secure pong")
})

test("TC11 a name outside the CA's limits is refused", async () => {
  const s = start("nc-bad-server")
  useProject(dir, providerConfig(s.port, file("nc-ca.pem")))
  const r = await ask()
  expect(r.error?.message).toContain("name constraint")
  expect(s.seen).toHaveLength(0)
})

test("TC11 Bun cannot verify a leaf with an IP name under a CA that has IP constraints (recorded behaviour)", async () => {
  const s = start("nc-ip-server")
  useProject(dir, providerConfig(s.port, file("nc-ip-ca.pem")))
  const r = await ask()
  expect(r.error?.message).toContain("IP-address name constraints")
  expect(s.seen).toHaveLength(0)
})

// ---- TC12: secrets -----------------------------------------------------------------------

test("TC12 the key appears in no error, debug output or provider problem text", async () => {
  const s = start("server")
  useProject(dir, providerConfig(s.port))
  const r = await ask()
  const lines: string[] = []
  const p = (await allProviders()).tlsp!
  await runLocalDebug({ providers: [p], endpoints: { llamacpp: "http://127.0.0.1:9", ollama: "http://127.0.0.1:9", lmstudio: "http://127.0.0.1:9", vllm: "http://127.0.0.1:9" }, out: (l = "") => lines.push(l), timeoutMs: 1500 })
  const everything = [r.error?.message, r.error?.stack, ...lines].join("\n")
  expect(everything).not.toContain(KEY)
  expect(lines.join("\n")).toContain("TLS: !")
  expect(lines.join("\n")).toContain("is not trusted")
})

// ---- TC13: Diparnux features over HTTPS --------------------------------------------------

const INFO = { diparnux: "0.5.4", server: "running", model: "m", ctx_per_slot: 16384, slots: 1 }

test("TC13 /diparnux/info, the slot limit and the tool check all work over HTTPS with options.ca", async () => {
  delete process.env.VEDECAPS_DISABLE_LOCAL_DETECT
  const dead = "http://127.0.0.1:9"
  setDefaultEndpoints({ llamacpp: dead, ollama: dead, lmstudio: dead, vllm: dead })
  const s = start("server", { delayMs: 120, info: INFO })
  useProject(dir, { ...providerConfig(s.port, file("ca.pem")), local_detect: true })
  resetProviders()

  const p = (await allProviders()).tlsp!
  expect(p.diparnux).toMatchObject({ version: "0.5.4", slots: 1, ctxPerSlot: 16384 })
  expect(p.maxConcurrency).toBe(1)
  expect(p.maxConcurrencySource).toBe("diparnux")
  expect(Object.keys(p.models)).toContain("m")
  // the info request carries no credentials
  expect(s.seen.filter((x) => x.path === "/diparnux/info").every((x) => x.auth === undefined)).toBe(true)

  // two requests at once: the server never sees more than one
  const { provider, model } = await getModel("tlsp", "m")
  const run = (t: string) => generateText({ provider, model, system: [], messages: [{ role: "user", content: [{ type: "text", text: t }] }] })
  const [a, b] = await Promise.all([run("one"), run("two")])
  expect([a, b]).toEqual(["secure pong", "secure pong"])
  expect(s.maxInflight).toBe(1)

  // tool check with the provider's trust
  const check = await checkToolCalling({ baseURL: provider.baseURL!, model: "m", apiKey: provider.apiKey, tls: provider.tls, providerID: "tlsp" })
  expect(check.status).toBe("ok")
  const refused = await checkToolCalling({ baseURL: provider.baseURL!, model: "m", providerID: "tlsp" })
  expect(refused.status).toBe("error")
  expect(refused.detail).toContain("provider.tlsp.options.ca")

  // debug local shows the certificate state
  const lines: string[] = []
  await runLocalDebug({ providers: [p], checkTools: true, endpoints: { llamacpp: dead, ollama: dead, lmstudio: dead, vllm: dead }, out: (l = "") => lines.push(l), timeoutMs: 3000 })
  const text = lines.join("\n")
  expect(text).toContain("TLS: certificate accepted, trusted by ca.pem")
  expect(text).toMatch(/CA SHA-256 ([0-9A-F]{2}:){31}[0-9A-F]{2}/)
  expect(text).toContain("Diparnux 0.5.4")
  expect(text).toContain("tool call check: ok")
  expect(text).not.toContain(KEY)
})

// ---- error classification ----------------------------------------------------------------

test("describeTlsError recognises the nested codes and leaves everything else alone", () => {
  const ctx = { providerID: "gw", host: "spark.local:8444", hasCA: false }
  expect(describeTlsError(Object.assign(new TypeError("x"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }), ctx)).toContain("provider.gw.options.ca")
  expect(describeTlsError(new Error("outer", { cause: Object.assign(new Error("inner"), { code: "CERT_HAS_EXPIRED" }) }), ctx)).toContain("diparnux tls renew")
  expect(tlsErrorCode(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBeUndefined()
  expect(describeTlsError(new Error("socket hang up"), ctx)).toBeUndefined()
  expect(describeTlsError(Object.assign(new Error("x"), { code: "ECONNREFUSED" }), ctx)).toBeUndefined()
})
