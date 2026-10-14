import { getMessages, listSessions } from "../../session/store"
import { totalTokens } from "../../session/message"
import { parse, type CommandSpec } from "../args"
import { bootstrap } from "../bootstrap"

export const spec: CommandSpec = {
  usage: "deberopa stats [options]",
  description: "token usage and cost across your sessions",
  options: {
    all: { type: "boolean", description: "include every project, not just this one" },
    days: { type: "string", short: "d", arg: "n", description: "only sessions updated in the last n days" },
    help: { type: "boolean", short: "h", description: "show this help" },
  },
}

const n = (value: number) => value.toLocaleString("en-US")

export async function main(argv: string[]): Promise<number> {
  const { values } = parse(argv, spec.options!)
  await bootstrap()
  const cutoff = values.days ? Date.now() - Number(values.days) * 86_400_000 : 0
  const sessions = (await listSessions({ all: values.all, includeChildren: true })).filter((s) => s.time.updated >= cutoff)
  const byModel = new Map<string, { messages: number; input: number; output: number; cache: number; cost: number }>()
  let messages = 0
  let cost = 0
  let tokens = 0
  for (const session of sessions) {
    for (const m of await getMessages(session.id)) {
      messages++
      if (m.role !== "assistant" || !m.modelID) continue
      const key = `${m.providerID}/${m.modelID}`
      const row = byModel.get(key) ?? { messages: 0, input: 0, output: 0, cache: 0, cost: 0 }
      row.messages++
      row.input += m.tokens.input
      row.output += m.tokens.output
      row.cache += m.tokens.cacheRead + m.tokens.cacheWrite
      row.cost += m.cost
      byModel.set(key, row)
      cost += m.cost
      tokens += totalTokens(m.tokens)
    }
  }
  const out = (s = "") => process.stdout.write(s + "\n")
  out(`Sessions   ${n(sessions.length)}`)
  out(`Messages   ${n(messages)}`)
  out(`Tokens     ${n(tokens)}`)
  out(`Cost       $${cost.toFixed(4)}`)
  if (byModel.size) {
    out()
    out("By model")
    for (const [model, row] of [...byModel].sort((a, b) => b[1].cost - a[1].cost)) {
      out(`  ${model}`)
      out(`    ${n(row.messages)} responses · in ${n(row.input)} · out ${n(row.output)} · cache ${n(row.cache)} · $${row.cost.toFixed(4)}`)
    }
  }
  return 0
}
