/**
 * Smoke test for a compiled deberopa binary: bun run script/smoke.ts <path-to-binary>
 * (or compile this file and run it inside a clean container next to the binary).
 * It starts a tiny OpenAI-compatible server and drives the binary against it.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { targetName } from "../src/update/update"
import { createHash } from "node:crypto"

const bin = path.resolve(process.argv[2] ?? "")
if (!process.argv[2] || !fs.existsSync(bin)) {
  console.error("usage: smoke <path-to-deberopa-binary>")
  process.exit(2)
}

const queue: any[][] = []
const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason: finish }] })
const text = (t: string) => [chunk({ role: "assistant" }), chunk({ content: t }), chunk({}, "stop"), { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } }]
const tool = (name: string, args: unknown) => [
  chunk({ role: "assistant" }),
  chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name, arguments: JSON.stringify(args) } }] }),
  chunk({}, "tool_calls"),
  { choices: [], usage: { prompt_tokens: 9, completion_tokens: 4 } },
]
const seen: any[] = []

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    // Only chat completions are model turns. Probes (/models, /opereta/info, ...) must not
    // consume the scripted replies, exactly like a real server that has no such route.
    if (!new URL(req.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
    const body: any = await req.json().catch(() => ({}))
    const first = String(body.messages?.[0]?.content ?? "")
    const events = first.startsWith("You generate short titles") ? text("Smoke") : (seen.push(body), queue.shift() ?? text("ok"))
    return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  },
})

const home = fs.mkdtempSync(path.join(os.tmpdir(), "vdc-smoke-"))
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vdc-smoke-work-")))
fs.writeFileSync(path.join(work, "hello.txt"), "greetings from the smoke test\n")
const config = {
  model: "mock/m",
  snapshot: false,
  provider: { mock: { name: "Mock", api: `http://127.0.0.1:${server.port}/v1`, models: { m: { name: "M", tool_call: true, limit: { context: 100000, output: 4000 } } } } },
}

async function deberopa(args: string[], stdin?: string) {
  const proc = Bun.spawn([bin, ...args], {
    cwd: work,
    env: { ...process.env, DEBEROPA_HOME: home, DEBEROPA_DISABLE_MODELS_FETCH: "1", DEBEROPA_CONFIG_CONTENT: JSON.stringify(config), NO_COLOR: "1" },
    stdin: stdin !== undefined ? new TextEncoder().encode(stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { stdout, stderr, code }
}

let failures = 0
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  ${detail}`}`)
  if (!ok) failures++
}

const version = await deberopa(["--version"])
check("--version", version.code === 0 && /^\d+\.\d+\.\d+/.test(version.stdout.trim()), JSON.stringify(version))

const help = await deberopa(["--help"])
check("--help", help.code === 0 && help.stdout.includes("deberopa run"), JSON.stringify(help).slice(0, 300))

queue.push(text("Hello from the smoke test."))
const plain = await deberopa(["run", "say hello"])
check("run: text reply", plain.code === 0 && plain.stdout.trim() === "Hello from the smoke test.", JSON.stringify(plain))

queue.push(tool("read", { filePath: path.join(work, "hello.txt") }), text("The file contains a greeting."))
const withTool = await deberopa(["run", "read hello.txt"])
const toolReply = seen.at(-1)?.messages?.find((m: any) => m.role === "tool")?.content ?? ""
check("run: tool round trip", withTool.code === 0 && withTool.stdout.includes("greeting") && String(toolReply).includes("greetings from the smoke test"), JSON.stringify(withTool))

// An installed package resolves in the compiled runtime without npm, Node, or Bun on PATH.
{
  const spec = "fixture-plugin@1.2.3"
  const data = path.join(home, "data", "plugins", createHash("sha256").update(spec).digest("hex"))
  const moduleDir = path.join(data, "node_modules", "fixture-plugin")
  fs.mkdirSync(moduleDir, { recursive: true })
  fs.writeFileSync(path.join(data, "package-lock.json"), "{}")
  fs.writeFileSync(path.join(moduleDir, "package.json"), JSON.stringify({ name: "fixture-plugin", version: "1.2.3", type: "module", exports: "./index.js" }))
  fs.writeFileSync(path.join(moduleDir, "index.js"), 'export default () => ({tool:{fixture:{description:"Fixture",parameters:{type:"object",properties:{}},execute:()=>"package plugin worked"}}})')
  ;(config as any).plugin = ["npm:" + spec]
  queue.push(tool("fixture", {}), text("plugin done"))
  const result = await deberopa(["run", "use the fixture plugin"])
  check("npm plugin in compiled binary", result.code === 0 && seen.at(-1)?.messages?.some((m: any) => m.role === "tool" && String(m.content).includes("package plugin worked")), JSON.stringify(result))
  delete (config as any).plugin
}

queue.push(text("from stdin"))
const piped = await deberopa(["run", "echo"], "piped input")
check("run: piped stdin", piped.code === 0 && String(seen.at(-1)?.messages?.at(-1)?.content).includes("piped input"), JSON.stringify(piped))

const models = await deberopa(["models"])
check("models", models.code === 0 && models.stdout.includes("mock/m"), JSON.stringify(models))

const debug = await deberopa(["debug"])
check("debug", debug.code === 0 && debug.stdout.includes("Providers"), JSON.stringify(debug).slice(0, 300))

// serve: the HTTP API answers on a free port
{
  const proc = Bun.spawn([bin, "serve", "--port", "0"], {
    cwd: work,
    env: { ...process.env, DEBEROPA_HOME: home, DEBEROPA_DISABLE_MODELS_FETCH: "1", DEBEROPA_CONFIG_CONTENT: JSON.stringify(config) },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  let ok = false
  let detail = ""
  try {
    const reader = proc.stdout.getReader()
    let printed = ""
    const deadline = Date.now() + 15_000
    while (!/http:\/\/[^\s]+:\d+/.test(printed) && Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      printed += new TextDecoder().decode(value)
    }
    const url = /http:\/\/[^\s]+:\d+/.exec(printed)?.[0]
    if (url) {
      const health: any = await fetch(url + "/health").then((r) => r.json())
      const agents: any = await fetch(url + "/agent").then((r) => r.json())
      ok = health.ok === true && agents.some((a: any) => a.name === "build")
      detail = JSON.stringify(health)
    } else detail = "no listening line: " + printed
  } catch (err) {
    detail = String(err)
  }
  proc.kill()
  await proc.exited
  check("serve: HTTP API", ok, detail)
}

// upgrade: download from a (local) release host, verify the checksum, swap the executable
{
  const { createHash } = await import("node:crypto")
  const windows = process.platform === "win32"
  const exe = windows ? "deberopa.exe" : "deberopa"
  const target = targetName()
  const asset = `deberopa-${target}.${windows ? "zip" : "tar.gz"}`
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "vdc-smoke-release-"))
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "vdc-smoke-install-"))
  const installed = path.join(installDir, exe)
  fs.copyFileSync(bin, path.join(stage, exe))
  fs.copyFileSync(bin, installed)
  fs.chmodSync(installed, 0o755)
  const packed = Bun.spawnSync(windows ? ["tar", "-a", "-c", "-f", asset, exe] : ["tar", "-czf", asset, exe], { cwd: stage })
  const current = version.stdout.trim()
  let ok = false
  let detail = packed.exitCode === 0 ? "" : "could not package: " + packed.stderr.toString()
  if (packed.exitCode === 0) {
    const digest = createHash("sha256").update(fs.readFileSync(path.join(stage, asset))).digest("hex")
    const release = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === "/latest") return new Response(null, { status: 302, headers: { location: `/tag/v${current}` } })
        if (url.pathname === `/download/v${current}/checksums.txt`) return new Response(`${digest}  ${asset}\n`)
        if (url.pathname === `/download/v${current}/${asset}`) return new Response(Bun.file(path.join(stage, asset)))
        if (url.pathname === `/download/v9.9.9/checksums.txt`) return new Response(`${"0".repeat(64)}  ${asset}\n`)
        if (url.pathname === `/download/v9.9.9/${asset}`) return new Response(Bun.file(path.join(stage, asset)))
        return new Response("not found", { status: 404 })
      },
    })
    const env = { ...process.env, DEBEROPA_HOME: home, DEBEROPA_RELEASE_URL: `http://127.0.0.1:${release.port}` }
    const runInstalled = async (args: string[]) => {
      const proc = Bun.spawn([installed, ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
      return { stdout, stderr, code }
    }
    const upToDate = await runInstalled(["upgrade", "--check"])
    const forced = await runInstalled(["upgrade", "--force"])
    const after = await runInstalled(["--version"])
    const tampered = await runInstalled(["upgrade", "9.9.9"])
    ok =
      upToDate.code === 0 && upToDate.stdout.includes("up to date") &&
      forced.code === 0 && forced.stdout.includes("Updated") &&
      after.code === 0 && after.stdout.trim() === current &&
      tampered.code === 1 && tampered.stderr.includes("Checksum mismatch")
    detail = JSON.stringify({ upToDate, forced, after, tampered })
    release.stop(true)
  }
  check("upgrade: verified self-replace, tampered download refused", ok, detail)
  fs.rmSync(stage, { recursive: true, force: true })
  fs.rmSync(installDir, { recursive: true, force: true })
}

server.stop(true)
fs.rmSync(home, { recursive: true, force: true })
fs.rmSync(work, { recursive: true, force: true })
console.log(failures === 0 ? "\nsmoke test passed" : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
