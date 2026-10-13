import { parseArgs, type ParseArgsConfig } from "node:util"

export type OptionSpec = Record<string, { type: "string" | "boolean"; short?: string; multiple?: boolean; description: string; arg?: string }>

export interface CommandSpec {
  usage: string
  description: string
  options?: OptionSpec
  examples?: string[]
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UsageError"
  }
}

export function parse<T extends OptionSpec>(argv: string[], spec: T) {
  try {
    return parseArgs({ args: argv, options: spec as ParseArgsConfig["options"], allowPositionals: true, strict: true }) as {
      values: Record<string, any>
      positionals: string[]
    }
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message.replace(/^.*?: /, "") : String(err))
  }
}

export function helpText(name: string, spec: CommandSpec): string {
  const lines = [`vedecaps ${name} - ${spec.description}`, "", `Usage: ${spec.usage}`]
  const options = Object.entries(spec.options ?? {})
  if (options.length) {
    lines.push("", "Options:")
    const rows = options.map(([key, o]) => {
      const flag = `${o.short ? `-${o.short}, ` : "    "}--${key}${o.type === "string" ? ` <${o.arg ?? "value"}>` : ""}`
      return [flag, o.description] as const
    })
    const width = Math.max(...rows.map((r) => r[0].length))
    for (const [flag, description] of rows) lines.push(`  ${flag.padEnd(width)}  ${description}`)
  }
  if (spec.examples?.length) lines.push("", "Examples:", ...spec.examples.map((e) => `  ${e}`))
  return lines.join("\n")
}
