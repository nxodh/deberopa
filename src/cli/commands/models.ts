import { allProviders } from "../../provider/provider"
import { refreshCatalog } from "../../provider/models"
import { resetProviders } from "../../provider/provider"
import { parse, type CommandSpec } from "../args"
import { bootstrap } from "../bootstrap"

export const spec: CommandSpec = {
  usage: "vedecaps models [provider] [options]",
  description: "list the models you can use",
  options: {
    refresh: { type: "boolean", description: "download the latest model catalog from models.dev first" },
    all: { type: "boolean", description: "include providers you have no credentials for" },
    verbose: { type: "boolean", short: "v", description: "show context size and pricing" },
    help: { type: "boolean", short: "h", description: "show this help" },
  },
  examples: ["vedecaps models", "vedecaps models anthropic -v", "vedecaps models --refresh --all"],
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, spec.options!)
  await bootstrap()
  if (values.refresh) {
    const ok = await refreshCatalog()
    if (!ok) process.stderr.write("Could not download the catalog (offline?); using what is cached.\n")
    resetProviders()
  }
  const providers = Object.values(await allProviders())
  const only = positionals[0]
  const selected = providers
    .filter((p) => (only ? p.id === only : values.all || p.source !== "none"))
    .sort((a, b) => a.id.localeCompare(b.id))
  if (only && selected.length === 0) {
    process.stderr.write(`Unknown provider "${only}".\n`)
    return 1
  }
  if (selected.length === 0) {
    process.stdout.write("No providers with credentials. Run `vedecaps auth login`, or use --all to list everything.\n")
    return 0
  }
  for (const provider of selected) {
    for (const model of Object.values(provider.models).sort((a, b) => a.id.localeCompare(b.id))) {
      if (values.verbose) {
        const ctx = model.limit.context ? `${Math.round(model.limit.context / 1000)}k ctx` : "?"
        const price = model.cost.input || model.cost.output ? `$${model.cost.input}/$${model.cost.output} per M` : "free/unknown"
        process.stdout.write(`${provider.id}/${model.id}\t${ctx}\t${price}${model.reasoning ? "\treasoning" : ""}\n`)
      } else process.stdout.write(`${provider.id}/${model.id}\n`)
    }
  }
  return 0
}
