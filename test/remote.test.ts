import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import { globalConfigFile } from "../src/config/config"
import { stripUntrusted } from "../src/config/trust"
import { allCredentials } from "../src/auth/auth"
import { allProviders } from "../src/provider/provider"
import { addRemoteHost, checkRemote, hostID, lanInterfaces, listRemoteHosts, parseHost, removeRemoteHost, scanNetwork } from "../src/provider/remote"
import { startServer } from "../src/server/server"
import { endProject, mockConfig, startMockLLM, tmpDir, useProject, type MockLLM } from "./helpers"

const FAKE_KEY = "sk-test-not-a-real-key-remote"

// A fake Ollama that optionally wants a bearer key, and remembers every Authorization header it saw.
let ollama: ReturnType<typeof Bun.serve>
let wantKey: string | undefined
let seenAuth: (string | null)[] = []
// A fake OpenAI-compatible server (LM Studio's plain fallback, vLLM without max_model_len, ...)
let generic: ReturnType<typeof Bun.serve>
let mock: MockLLM
let api: ReturnType<typeof startServer>

beforeAll(() => {
  mock = startMockLLM()
  ollama = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url)
      seenAuth.push(req.headers.get("authorization"))
      if (wantKey && req.headers.get("authorization") !== `Bearer ${wantKey}`) return new Response("unauthorized", { status: 401 })
      if (url.pathname === "/") return new Response("Ollama is running")
      if (url.pathname === "/api/tags") return Response.json({ models: [{ name: "qwen3:8b", details: { parameter_size: "8B", quantization_level: "Q4_K_M" } }] })
      if (url.pathname === "/api/show") return Response.json({ model_info: { "qwen3.context_length": 32768 }, capabilities: ["completion", "tools"] })
      return new Response("not found", { status: 404 })
    },
  })
  generic = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "some-model" }] })
      if (url.pathname === "/") return new Response("ok")
      return new Response("not found", { status: 404 })
    },
  })
  useProject(tmpDir(), mockConfig(mock))
  api = startServer({ port: 0 })
})

afterAll(async () => {
  api.stop(true)
  ollama.stop(true)
  generic.stop(true)
  mock.stop()
  await fs.rm(globalConfigFile(), { force: true })
  endProject()
})

const at = (server: ReturnType<typeof Bun.serve>) => `127.0.0.1:${server.port}`

test("addresses are normalised and bad ones explained", () => {
  expect(parseHost("192.168.0.20")).toMatchObject({ ok: true, root: "http://192.168.0.20" })
  expect(parseHost("gpu.local:11434")).toMatchObject({ ok: true, root: "http://gpu.local:11434", secure: false })
  expect(parseHost("https://lab.example:8443/v1/")).toMatchObject({ ok: true, root: "https://lab.example:8443", secure: true })
  expect(parseHost("[fd00::5]:8080")).toMatchObject({ ok: true, root: "http://[fd00::5]:8080" })
  for (const bad of ["", "ftp://host", "http://user:pw@host", "http://host/api/secret", "http://"]) expect(parseHost(bad).ok).toBe(false)
  expect(hostID("GPU Box #2")).toBe("gpu-box-2")
})

test("an Ollama on the network is recognised with its models", async () => {
  wantKey = undefined
  const check = await checkRemote(at(ollama))
  expect(check.ok).toBe(true)
  expect(check.server?.kind).toBe("ollama")
  expect(check.server?.protocol).toBe("ollama")
  expect(check.server?.models.map((m) => m.id)).toEqual(["qwen3:8b"])
  expect(check.server?.models[0]?.context).toBe(16384) // the context cap, not the model's 32768
  expect(typeof check.latencyMs).toBe("number")
})

test("an OpenAI-compatible server is recognised, with /v1 in its address", async () => {
  const check = await checkRemote(`http://${at(generic)}`)
  expect(check.ok).toBe(true)
  expect(check.server?.kind).toBe("openai")
  expect(check.server?.baseURL).toBe(`http://${at(generic)}/v1`)
})

test("a server that wants a key says so, refuses a wrong one, and takes the right one", async () => {
  wantKey = FAKE_KEY
  const none = await checkRemote(at(ollama))
  expect(none.problem?.code).toBe("needs-key")
  const wrong = await checkRemote(at(ollama), { key: "sk-test-wrong" })
  expect(wrong.problem?.code).toBe("key-refused")
  const right = await checkRemote(at(ollama), { key: FAKE_KEY })
  expect(right.ok).toBe(true)
  wantKey = undefined
})

test("nothing listening is reported with a way forward", async () => {
  const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") })
  const port = closed.port
  closed.stop(true)
  const check = await checkRemote(`127.0.0.1:${port}`, { timeoutMs: 1500 })
  expect(check.ok).toBe(false)
  expect(check.problem?.code).toBe("unreachable")
  expect(check.problem?.message).toContain("OLLAMA_HOST=0.0.0.0")
})

test("a key is never sent in the clear to an address outside private networks", async () => {
  const check = await checkRemote("http://203.0.113.9:11434", { key: FAKE_KEY })
  expect(check.problem?.code).toBe("key-over-plain-http")
  // private ranges, and the VPN range Tailscale uses, are fine
  for (const ok of ["http://192.168.1.5:11434", "http://10.0.0.2:11434", "http://100.100.1.1:11434"]) {
    const result = await checkRemote(ok, { key: FAKE_KEY, timeoutMs: 200 })
    expect(result.problem?.code).not.toBe("key-over-plain-http")
  }
})

test("a scan finds servers, sends no key, and only walks private addresses", async () => {
  seenAuth = []
  const saved = process.env.OPERETA_API_KEY
  process.env.OPERETA_API_KEY = FAKE_KEY
  try {
    const result = await scanNetwork({ hosts: ["127.0.0.1"], ports: [ollama.port!, generic.port!, 9], timeoutMs: 300 })
    expect(result.tried).toBe(3)
    expect(result.found.map((c) => c.server?.kind).sort()).toEqual(["ollama", "openai"])
    // not even the key the environment holds for local gateways
    expect(seenAuth.filter((h) => h !== null)).toEqual([])
  } finally {
    if (saved === undefined) delete process.env.OPERETA_API_KEY
    else process.env.OPERETA_API_KEY = saved
  }
  await expect(scanNetwork({ hosts: ["8.8.8.8"] })).rejects.toThrow("private network")
  await expect(scanNetwork({ hosts: ["example.com"] })).rejects.toThrow("private network")
})

test("a scan reports servers that want a key without trying any", async () => {
  wantKey = FAKE_KEY
  seenAuth = []
  const result = await scanNetwork({ hosts: ["127.0.0.1"], ports: [ollama.port!], timeoutMs: 300 })
  expect(result.found).toEqual([])
  expect(result.needKey.length).toBe(1)
  expect(seenAuth.every((h) => h === null)).toBe(true)
  wantKey = undefined
})

test("the network to scan comes from this computer's private IPv4 interfaces", () => {
  const rows = lanInterfaces({
    en0: [{ address: "192.168.45.31", netmask: "255.255.255.0", family: "IPv4", mac: "", internal: false, cidr: null }],
    lo0: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "", internal: true, cidr: null }],
    utun: [{ address: "100.64.0.9", netmask: "255.255.255.255", family: "IPv4", mac: "", internal: false, cidr: null }],
    wan: [{ address: "203.0.113.7", netmask: "255.255.255.0", family: "IPv4", mac: "", internal: false, cidr: null }],
  } as any)
  expect(rows.length).toBe(1)
  expect(rows[0]!.hosts.length).toBe(253)
  expect(rows[0]!.hosts).not.toContain("192.168.45.31")
  expect(rows[0]!.hosts[0]).toBe("192.168.45.1")
})

test("a host is saved as a provider, its key kept apart, and its models found", async () => {
  wantKey = FAKE_KEY
  const saved = process.env.DEBEROPA_DISABLE_LOCAL_DETECT
  delete process.env.DEBEROPA_DISABLE_LOCAL_DETECT
  try {
    const { host, check } = await addRemoteHost({ name: "GPU Box", url: at(ollama), key: FAKE_KEY })
    expect(check.ok).toBe(true)
    expect(host).toMatchObject({ id: "gpu-box", protocol: "ollama", hasKey: true, hasCA: false })

    // config holds the address, never the key
    const file = await fs.readFile(globalConfigFile(), "utf8")
    expect(file).toContain(`"remote": true`)
    expect(file).not.toContain(FAKE_KEY)
    expect((await allCredentials())["gpu-box"]).toEqual({ type: "api", key: FAKE_KEY })

    const providers = await allProviders()
    const p = providers["gpu-box"]!
    expect(p.local).toBe(true)
    expect(p.protocol).toBe("ollama")
    expect(Object.keys(p.models)).toEqual(["qwen3:8b"])
    expect(await listRemoteHosts()).toEqual([{ id: "gpu-box", name: "GPU Box", url: `http://${at(ollama)}`, protocol: "ollama", hasKey: true, hasCA: false }])

    expect(await removeRemoteHost("gpu-box")).toBe(true)
    expect(await listRemoteHosts()).toEqual([])
    expect((await allCredentials())["gpu-box"]).toBeUndefined()
    expect((await allProviders())["gpu-box"]).toBeUndefined()
    expect(await removeRemoteHost("gpu-box")).toBe(false)
  } finally {
    if (saved !== undefined) process.env.DEBEROPA_DISABLE_LOCAL_DETECT = saved
    wantKey = undefined
  }
})

test("a host that is switched off is still saved, with the reason", async () => {
  const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") })
  const port = closed.port
  closed.stop(true)
  const { host, check } = await addRemoteHost({ name: "sleeper", url: `127.0.0.1:${port}` })
  expect(host.id).toBe("sleeper")
  expect(check.problem?.code).toBe("unreachable")
  expect((await listRemoteHosts()).map((h) => h.id)).toEqual(["sleeper"])
  await removeRemoteHost("sleeper")
})

test("names that collide with built-in providers, and addresses that carry secrets, are refused", async () => {
  await expect(addRemoteHost({ name: "openai", url: at(ollama) })).rejects.toThrow("built-in provider")
  await expect(addRemoteHost({ name: "x", url: "http://user:pw@127.0.0.1:1" })).rejects.toThrow("user name")
  await expect(addRemoteHost({ name: "x", url: "http://203.0.113.9:11434", key: FAKE_KEY })).rejects.toThrow("unencrypted")
  expect(await listRemoteHosts()).toEqual([])
})

test("a repository cannot mark a provider as a model host", () => {
  const { config, blocked } = stripUntrusted({ provider: { openai: { remote: true } } })
  expect(config.provider?.openai?.remote).toBeUndefined()
  expect(blocked.join(" ")).toContain("provider.openai.remote")
})

const call = async (method: string, route: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:${api.port}${route}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } })
  const text = await res.text()
  let data: any = text
  try {
    data = JSON.parse(text)
  } catch {}
  return { status: res.status, data, text }
}

test("the server saves, checks, scans and removes hosts without ever returning a key", async () => {
  wantKey = FAKE_KEY
  const added = await call("POST", "/remote", { name: "lab", url: at(ollama), key: FAKE_KEY })
  expect(added.status).toBe(201)
  expect(added.data.check.ok).toBe(true)
  expect(added.text).not.toContain(FAKE_KEY)

  const list = await call("GET", "/remote")
  expect(list.data.map((h: any) => h.id)).toEqual(["lab"])
  expect(list.text).not.toContain(FAKE_KEY)

  const checked = await call("POST", "/remote/check", { id: "lab" })
  expect(checked.data.ok).toBe(true)
  expect(checked.data.server.models[0].id).toBe("qwen3:8b")
  // an address that is not saved never borrows the saved key
  const stranger = await call("POST", "/remote/check", { url: at(ollama) })
  expect(stranger.data.problem.code).toBe("needs-key")

  expect((await call("POST", "/remote/scan", { hosts: ["8.8.8.8"] })).status).toBe(400)
  const scanned = await call("POST", "/remote/scan", { hosts: ["127.0.0.1"] })
  expect(scanned.status).toBe(200)
  expect(scanned.data.tried).toBe(4)

  expect((await call("POST", "/remote", { name: "x" })).status).toBe(400)
  expect((await call("DELETE", "/remote/lab")).status).toBe(200)
  expect((await call("DELETE", "/remote/lab")).status).toBe(404)
  expect((await call("POST", "/remote/check", { id: "lab" })).status).toBe(404)
  wantKey = undefined
})
