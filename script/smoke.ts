/**
 * Smoke test for a compiled vedecaps binary: bun run script/smoke.ts <path-to-binary>
 * (or compile this file and run it inside a clean container next to the binary).
 * It starts a tiny OpenAI-compatible server and drives the binary against it.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const bin = path.resolve(process.argv[2] ?? "")
if (!process.argv[2] || !fs.existsSync(bin)) {
  console.error("usage: smoke <path-to-vedecaps-binary>")
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

async function vedecaps(args: string[], stdin?: string) {
  const proc = Bun.spawn([bin, ...args], {
    cwd: work,
    env: { ...process.env, VEDECAPS_HOME: home, VEDECAPS_DISABLE_MODELS_FETCH: "1", VEDECAPS_CONFIG_CONTENT: JSON.stringify(config), NO_COLOR: "1" },
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

const version = await vedecaps(["--version"])
check("--version", version.code === 0 && /^\d+\.\d+\.\d+/.test(version.stdout.trim()), JSON.stringify(version))

const help = await vedecaps(["--help"])
check("--help", help.code === 0 && help.stdout.includes("vedecaps run"), JSON.stringify(help).slice(0, 300))

queue.push(text("Hello from the smoke test."))
const plain = await vedecaps(["run", "say hello"])
check("run: text reply", plain.code === 0 && plain.stdout.trim() === "Hello from the smoke test.", JSON.stringify(plain))

queue.push(tool("read", { filePath: path.join(work, "hello.txt") }), text("The file contains a greeting."))
const withTool = await vedecaps(["run", "read hello.txt"])
const toolReply = seen.at(-1)?.messages?.find((m: any) => m.role === "tool")?.content ?? ""
check("run: tool round trip", withTool.code === 0 && withTool.stdout.includes("greeting") && String(toolReply).includes("greetings from the smoke test"), JSON.stringify(withTool))

queue.push(text("from stdin"))
const piped = await vedecaps(["run", "echo"], "piped input")
check("run: piped stdin", piped.code === 0 && String(seen.at(-1)?.messages?.at(-1)?.content).includes("piped input"), JSON.stringify(piped))

const models = await vedecaps(["models"])
check("models", models.code === 0 && models.stdout.includes("mock/m"), JSON.stringify(models))

const debug = await vedecaps(["debug"])
check("debug", debug.code === 0 && debug.stdout.includes("Providers"), JSON.stringify(debug).slice(0, 300))

server.stop(true)
fs.rmSync(home, { recursive: true, force: true })
fs.rmSync(work, { recursive: true, force: true })
console.log(failures === 0 ? "\nsmoke test passed" : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
