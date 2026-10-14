import path from "node:path"
import { parse, type CommandSpec } from "../args"
import { bootstrap } from "../bootstrap"
import { project } from "../../project"
import { loadConfig, resetConfig } from "../../config/config"
import { isTrusted, trustedProjects, trustProject, untrustProject } from "../../config/trust"

export const spec: CommandSpec = {
  usage: "deberopa trust [path] [options]",
  description: "allow a project's own config to run commands and set endpoints",
  options: {
    revoke: { type: "boolean", description: "stop trusting the project" },
    list: { type: "boolean", description: "list trusted projects" },
    status: { type: "boolean", description: "show what is currently ignored in this project" },
  },
  examples: ["deberopa trust", "deberopa trust ~/code/my-app", "deberopa trust --status", "deberopa trust --revoke", "deberopa trust --list"],
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, spec.options!)
  const out = (s: string) => process.stdout.write(s + "\n")
  if (values.list) {
    const list = await trustedProjects()
    out(list.length ? list.join("\n") : "No trusted projects.")
    return 0
  }
  await bootstrap({ directory: positionals[0] ? path.resolve(positionals[0]) : undefined })
  const root = project().worktree
  if (values.status || (!values.revoke && (await isTrusted(root)) && !positionals.length)) {
    resetConfig()
    const loaded = await loadConfig()
    out(`${root}: ${loaded.trusted ? "trusted" : "not trusted"}`)
    if (loaded.blocked.length) {
      out("Ignored until you trust it:")
      for (const b of loaded.blocked) out(`  - ${b}`)
      out("Review the files above, then run: deberopa trust")
    } else if (!loaded.trusted) out("Nothing in its config needs trust.")
    return 0
  }
  if (values.revoke) {
    out((await untrustProject(root)) ? `No longer trusting ${root}` : `${root} was not trusted.`)
    return 0
  }
  await trustProject(root)
  out(`Trusted ${root}. Its config may now start programs and set endpoints.`)
  return 0
}
