import { allCredentials, removeCredential, setCredential } from "../../auth/auth"
import { allProviders, resetProviders } from "../../provider/provider"
import { Paths } from "../../global"
import { readStdin, ask, choose } from "../input"
import { UsageError, type CommandSpec } from "../args"
import { bootstrap } from "../bootstrap"

export const spec: CommandSpec = {
  usage: "deberopa auth <login|list|logout> [provider]",
  description: "manage provider credentials",
  examples: [
    "deberopa auth login",
    "deberopa auth login anthropic",
    "echo $MY_KEY | deberopa auth login openrouter    # key from stdin",
    "deberopa auth list",
    "deberopa auth logout openai",
  ],
}

const POPULAR = ["anthropic", "openai", "google", "openrouter", "xai", "groq", "deepseek", "mistral", "togetherai", "fireworks-ai", "cerebras"]

const out = (line = "") => process.stdout.write(line + "\n")

export async function main(argv: string[]): Promise<number> {
  const [action, provider] = argv
  await bootstrap()
  if (action === "login") return login(provider)
  if (action === "list" || action === "ls") return list()
  if (action === "logout") return logout(provider)
  throw new UsageError(`Unknown auth action "${action ?? ""}". Use login, list or logout.`)
}

async function login(requested?: string): Promise<number> {
  const providers = await allProviders()
  let id = requested
  if (!id) {
    const ids = [...POPULAR.filter((p) => providers[p]), ...Object.keys(providers).filter((p) => !POPULAR.includes(p)).sort()]
    const top = ids.slice(0, POPULAR.length)
    const choice = await choose(
      "Select a provider",
      [...top.map((p) => ({ value: p, label: `${providers[p]!.name} (${p})` })), { value: "__other", label: "other (type a provider id)" }],
    )
    if (!choice) return 1
    id = choice === "__other" ? await ask("Provider id: ") : choice
  }
  const info = providers[id]
  if (!info) {
    process.stderr.write(`Unknown provider "${id}". Run \`deberopa models --all\` to see known providers, or define it under "provider" in deberopa.json.\n`)
    return 1
  }
  let key: string
  if (process.stdin.isTTY) {
    if (info.env[0]) process.stderr.write(`(You can also set ${info.env[0]} instead of storing a key.)\n`)
    key = await ask(`API key for ${info.name}: `, { mask: true })
  } else {
    key = (await readStdin({ firstByteTimeoutMs: 3000 })).trim().split(/\r?\n/)[0]?.trim() ?? ""
  }
  if (!key) {
    process.stderr.write("No key entered; nothing saved.\n")
    return 1
  }
  await setCredential(id, { type: "api", key })
  resetProviders()
  out(`Saved credentials for ${info.name} to ${Paths.auth}`)
  out(`Run \`deberopa models ${id}\` to see its models, then \`deberopa -m ${id}/<model>\`.`)
  return 0
}

async function list(): Promise<number> {
  const stored = await allCredentials()
  const providers = await allProviders()
  const rows: string[] = []
  for (const [id, cred] of Object.entries(stored)) {
    rows.push(`  ${(providers[id]?.name ?? id).padEnd(24)} ${cred.type === "api" ? "api key" : "oauth"}  (stored)`)
  }
  for (const info of Object.values(providers)) {
    if (stored[info.id]) continue
    if (info.source === "env") rows.push(`  ${info.name.padEnd(24)} ${(info.env.find((e) => process.env[e]) ?? "env").padEnd(8)}  (environment variable)`)
    else if (info.source === "config") rows.push(`  ${info.name.padEnd(24)} config    (deberopa.json)`)
  }
  out(`Credentials  ${Paths.auth}`)
  out()
  if (rows.length === 0) out("  none yet. Run `deberopa auth login`.")
  for (const row of rows) out(row)
  return 0
}

async function logout(requested?: string): Promise<number> {
  const stored = await allCredentials()
  const ids = Object.keys(stored)
  let id = requested
  if (!id) {
    if (ids.length === 0) {
      out("No stored credentials.")
      return 0
    }
    id = await choose("Remove which credential?", ids.map((p) => ({ value: p, label: p })))
    if (!id) return 1
  }
  if (await removeCredential(id)) out(`Removed credentials for ${id}.`)
  else {
    process.stderr.write(`No stored credentials for "${id}".\n`)
    return 1
  }
  return 0
}
