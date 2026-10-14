import { usageStats } from "../../session/stats"
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
  const stats = await usageStats({ all: values.all, days: values.days ? Number(values.days) : undefined })
  const out = (s = "") => process.stdout.write(s + "\n")
  out(`Sessions   ${n(stats.sessions)}`)
  out(`Messages   ${n(stats.messages)}`)
  out(`Tokens     ${n(stats.tokens)}`)
  out(`Cost       $${stats.cost.toFixed(4)}`)
  if (stats.models.length) {
    out()
    out("By model")
    for (const row of stats.models) {
      out(`  ${row.model}`)
      out(`    ${n(row.messages)} responses · in ${n(row.input)} · out ${n(row.output)} · cache ${n(row.cache)} · $${row.cost.toFixed(4)}`)
    }
  }
  return 0
}
