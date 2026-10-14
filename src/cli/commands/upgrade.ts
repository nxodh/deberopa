import { VERSION } from "../../global"
import { parse, type CommandSpec } from "../args"
import { bootstrap } from "../bootstrap"
import { latestVersion, upgrade, UpdateError, compareVersions } from "../../update/update"

export const spec: CommandSpec = {
  usage: "deberopa upgrade [version] [options]",
  description: "update deberopa to the latest (or a specific) release",
  options: {
    check: { type: "boolean", description: "only report whether an update is available" },
    force: { type: "boolean", description: "reinstall even when already on that version" },
  },
  examples: ["deberopa upgrade", "deberopa upgrade 0.1.0", "deberopa upgrade --check"],
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, spec.options!)
  await bootstrap()
  try {
    if (values.check) {
      const latest = await latestVersion()
      const newer = compareVersions(latest, VERSION) > 0
      process.stdout.write(newer ? `Update available: ${VERSION} -> ${latest}. Run \`deberopa upgrade\`.\n` : `deberopa ${VERSION} is up to date.\n`)
      return 0
    }
    const result = await upgrade({ version: positionals[0], force: values.force, onProgress: (m) => process.stderr.write(m + "\n") })
    process.stdout.write(result.changed ? `Updated deberopa ${result.from} -> ${result.to}\n` : `deberopa ${result.to} is already installed.\n`)
    return 0
  } catch (err) {
    if (err instanceof UpdateError) {
      process.stderr.write(err.message + "\n")
      return 1
    }
    throw err
  }
}
