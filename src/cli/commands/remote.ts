import { addRemoteHost, checkRemote, listRemoteHosts, parseHost, removeRemoteHost, scanNetwork, type RemoteCheck } from "../../provider/remote"
import { allProviders } from "../../provider/provider"
import { parse, UsageError, type CommandSpec } from "../args"
import { bootstrap } from "../bootstrap"
import { ask, readStdin } from "../input"

export const spec: CommandSpec = {
  usage: "deberopa remote [list|add <name> <url>|check [name|url]|scan|remove <name>]",
  description: "model servers on other computers: save, check and find them",
  options: {
    key: { type: "boolean", description: "ask for the server's API key (or read it from stdin)" },
    ca: { type: "string", arg: "file", description: "PEM file of the certificate authority the server's certificate must chain to" },
    hosts: { type: "string", arg: "a,b", description: "scan only these private IPv4 addresses instead of this computer's network" },
    help: { type: "boolean", short: "h", description: "show this help" },
  },
  examples: [
    "deberopa remote                                   # saved hosts",
    "deberopa remote scan                              # look on this network (sends no key)",
    "deberopa remote add gpu-box 192.168.0.20:11434    # Ollama on another computer",
    "deberopa remote add lab https://lab.example:8443 --key --ca ./lab-ca.pem",
    "deberopa remote check gpu-box                     # answers? which models? can it call tools?",
    "deberopa -m gpu-box/qwen3:8b                      # use it",
  ],
}

const out = (line = "") => process.stdout.write(line + "\n")
const err = (line = "") => process.stderr.write(line + "\n")

function describe(check: RemoteCheck): string[] {
  const lines: string[] = []
  if (check.server) {
    const s = check.server
    lines.push(`  ${s.name} at ${check.url}${check.latencyMs !== undefined ? ` · ${check.latencyMs} ms` : ""}`)
    if (s.opereta) lines.push(`  Opereta ${s.opereta.version}${s.opereta.slots ? ` · ${s.opereta.slots} slots` : ""}${s.opereta.state ? ` · ${s.opereta.state}` : ""}`)
    const shown = s.models.slice(0, 12)
    for (const m of shown) lines.push(`    ${m.id}${m.context ? ` · ${m.context.toLocaleString("en-US")} ctx` : ""}${m.details ? ` · ${m.details}` : ""}`)
    if (s.models.length > shown.length) lines.push(`    … and ${s.models.length - shown.length} more`)
    if (s.models.length === 0) lines.push("    (no models listed)")
  } else if (check.problem) {
    lines.push(`  ${check.url}: ${check.problem.message}`)
  }
  return lines
}

async function readKey(): Promise<string> {
  if (process.stdin.isTTY) return (await ask("API key: ", { mask: true })).trim()
  return (await readStdin({ firstByteTimeoutMs: 3000 })).trim().split(/\r?\n/)[0]?.trim() ?? ""
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, spec.options!)
  const [action = "list", ...rest] = positionals
  await bootstrap()

  if (action === "list" || action === "ls") {
    const hosts = await listRemoteHosts()
    if (hosts.length === 0) {
      out("No saved hosts. Look for servers on this network with `deberopa remote scan`, or add one:")
      out("  deberopa remote add <name> <host:port>")
      return 0
    }
    for (const h of hosts) out(`${h.id.padEnd(16)} ${h.url}  ${h.protocol}${h.hasKey ? " · key" : ""}${h.hasCA ? " · own CA" : ""}`)
    return 0
  }

  if (action === "add") {
    const [name, url] = rest
    if (!name || !url) throw new UsageError("Usage: deberopa remote add <name> <host:port> [--key] [--ca file]")
    const key = values.key ? await readKey() : undefined
    if (values.key && !key) {
      err("No key entered; nothing saved.")
      return 1
    }
    try {
      const { host, check } = await addRemoteHost({ name, url, key, ca: values.ca })
      out(`Saved ${host.id}: ${host.url}`)
      for (const line of describe(check)) out(line)
      if (!check.ok) err(`Saved, but the server was not usable yet: ${check.problem?.message ?? "unknown"}`)
      else out(`Use it: deberopa -m ${host.id}/${check.server!.models[0]?.id ?? "<model>"}`)
      return 0
    } catch (e) {
      err(e instanceof Error ? e.message : String(e))
      return 1
    }
  }

  if (action === "remove" || action === "rm") {
    const [id] = rest
    if (!id) throw new UsageError("Usage: deberopa remote remove <name>")
    if (!(await removeRemoteHost(id))) {
      err(`No saved host named "${id}".`)
      return 1
    }
    out(`Removed ${id}.`)
    return 0
  }

  if (action === "check") {
    const [target] = rest
    const hosts = await listRemoteHosts()
    const providers = await allProviders()
    const list = target ? hosts.filter((h) => h.id === target) : hosts
    if (target && list.length === 0) {
      // an address that is not saved
      if (!parseHost(target).ok) {
        err(`"${target}" is neither a saved host nor an address.`)
        return 1
      }
      const check = await checkRemote(target)
      for (const line of describe(check)) out(line)
      return check.ok ? 0 : 1
    }
    if (list.length === 0) {
      out("No saved hosts to check.")
      return 0
    }
    let code = 0
    for (const h of list) {
      const info = providers[h.id]
      const check = await checkRemote(h.url, { key: info?.apiKey, tls: info?.tls, providerID: h.id })
      out(`${h.id}:`)
      for (const line of describe(check)) out(line)
      if (!check.ok) code = 1
    }
    return code
  }

  if (action === "scan") {
    const hosts = values.hosts ? String(values.hosts).split(",").map((s) => s.trim()).filter(Boolean) : undefined
    out(hosts ? `Looking at ${hosts.length} address(es)…` : "Looking on this computer's network for Ollama, LM Studio, llama.cpp and vLLM (no key is sent)…")
    let result
    try {
      result = await scanNetwork({ hosts })
    } catch (e) {
      err(e instanceof Error ? e.message : String(e))
      return 1
    }
    if (!hosts && result.interfaces.length === 0) {
      err("This computer has no private IPv4 network to look at. Pass --hosts a,b or add a host by address.")
      return 1
    }
    for (const c of result.found) {
      out(`${c.url}`)
      for (const line of describe(c)) out(line)
      out(`  save it: deberopa remote add <name> ${c.url.replace(/^https?:\/\//, "")}`)
    }
    for (const c of result.needKey) out(`${c.url}: answers but needs an API key (add it with --key)`)
    if (result.found.length === 0 && result.needKey.length === 0) {
      out("Nothing found.")
      err("The server must listen on the network, not only on localhost (Ollama: OLLAMA_HOST=0.0.0.0; llama-server: --host 0.0.0.0), and its port must be open in the firewall.")
    }
    out(`${result.tried} addresses tried in ${(result.durationMs / 1000).toFixed(1)} s.`)
    return 0
  }

  throw new UsageError(`Unknown action "${action}". Use list, add, check, scan or remove.`)
}
