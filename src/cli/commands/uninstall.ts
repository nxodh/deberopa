import type { CommandSpec } from "../args"
export const spec: CommandSpec = { usage: "vedecaps uninstall", description: "uninstall" }
export async function main(_argv: string[]): Promise<number> {
  process.stderr.write("not implemented yet\n")
  return 1
}
