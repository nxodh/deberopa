import { VERSION } from "./global"
import { helpText, UsageError, type CommandSpec } from "./cli/args"
import { runAndExit } from "./cli/bootstrap"

interface Entry {
  spec: CommandSpec
  run(argv: string[]): Promise<number>
}

/** Subcommands, loaded lazily so `vedecaps --version` and `run` never pay for the TUI. */
const COMMANDS: Record<string, () => Promise<Entry>> = {
  run: async () => {
    const m = await import("./cli/commands/run")
    return { spec: m.spec, run: m.main }
  },
  auth: async () => {
    const m = await import("./cli/commands/auth")
    return { spec: m.spec, run: m.main }
  },
  models: async () => {
    const m = await import("./cli/commands/models")
    return { spec: m.spec, run: m.main }
  },
  agent: async () => {
    const m = await import("./cli/commands/agent")
    return { spec: m.spec, run: m.main }
  },
  session: async () => {
    const m = await import("./cli/commands/session")
    return { spec: m.spec, run: m.main }
  },
  export: async () => {
    const m = await import("./cli/commands/export")
    return { spec: m.exportSpec, run: m.exportMain }
  },
  import: async () => {
    const m = await import("./cli/commands/export")
    return { spec: m.importSpec, run: m.importMain }
  },
  mcp: async () => {
    const m = await import("./cli/commands/mcp")
    return { spec: m.spec, run: m.main }
  },
  stats: async () => {
    const m = await import("./cli/commands/stats")
    return { spec: m.spec, run: m.main }
  },
  debug: async () => {
    const m = await import("./cli/commands/debug")
    return { spec: m.spec, run: m.main }
  },
}

const SUMMARY: [string, string][] = [
  ["vedecaps [project]", "start the terminal UI (default)"],
  ["vedecaps run [message..]", "run a prompt non-interactively"],
  ["vedecaps auth login|list|logout", "manage provider credentials"],
  ["vedecaps models [provider]", "list available models"],
  ["vedecaps agent list|create", "list or create agents"],
  ["vedecaps session list|delete", "manage saved sessions"],
  ["vedecaps export [id]", "export a session as JSON or Markdown"],
  ["vedecaps import <file>", "import an exported session"],
  ["vedecaps mcp list|add|remove", "manage MCP servers"],
  ["vedecaps stats", "token usage and cost"],
  ["vedecaps serve", "start the HTTP API server"],
  ["vedecaps upgrade [version]", "update vedecaps to the latest release"],
  ["vedecaps uninstall", "remove vedecaps from this machine"],
  ["vedecaps debug", "show paths, config and tooling"],
]

function mainHelp(): string {
  const width = Math.max(...SUMMARY.map((r) => r[0].length))
  return [
    `Vedecaps ${VERSION} - an AI coding agent for your terminal`,
    "",
    "Usage: vedecaps [project] [options]",
    "       vedecaps <command> [options]",
    "",
    "Commands:",
    ...SUMMARY.map(([c, d]) => `  ${c.padEnd(width)}  ${d}`),
    "",
    "Options:",
    "  -c, --continue           continue the last session",
    "  -s, --session <id>       continue a specific session",
    "  -m, --model <p/model>    model to use, e.g. anthropic/claude-sonnet-5-5",
    "      --agent <name>       agent to start with (build, plan, ...)",
    "  -p, --prompt <text>      send this prompt as soon as the UI opens",
    "      --print-logs         print logs to stderr",
    "  -v, --version            show the version",
    "  -h, --help               show help (also: vedecaps <command> --help)",
    "",
    "Docs: https://github.com/nxodh/vedecaps",
  ].join("\n")
}

async function main(argv: string[]): Promise<number> {
  const first = argv[0]
  if (first === "--version" || first === "-v" || first === "version") {
    process.stdout.write(VERSION + "\n")
    return 0
  }
  if (first === "--help" || first === "-h" || first === "help") {
    if (first === "help" && argv[1] && COMMANDS[argv[1]]) return main([argv[1], "--help"])
    process.stdout.write(mainHelp() + "\n")
    return 0
  }

  if (first === "serve" || first === "upgrade" || first === "uninstall") {
    const m = await import("./cli/commands/" + first)
    if (argv.includes("--help") || argv.includes("-h")) {
      process.stdout.write(helpText(first, m.spec) + "\n")
      return 0
    }
    return m.main(argv.slice(1))
  }

  const load = first ? COMMANDS[first] : undefined
  if (load) {
    const entry = await load()
    if (argv.includes("--help") || argv.includes("-h")) {
      process.stdout.write(helpText(first!, entry.spec) + "\n")
      return 0
    }
    return entry.run(argv.slice(1))
  }

  if (first && !first.startsWith("-") && !(await isDirectory(first))) {
    throw new UsageError(`Unknown command "${first}". Run \`vedecaps --help\` to see what is available.`)
  }
  const tui = await import("./cli/commands/tui")
  return tui.main(argv)
}

async function isDirectory(p: string): Promise<boolean> {
  const fs = await import("node:fs/promises")
  return fs.stat(p).then((s) => s.isDirectory(), () => false)
}

void runAndExit(async () => {
  try {
    return await main(process.argv.slice(2))
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n\nRun \`vedecaps --help\` for usage.\n`)
      return 2
    }
    throw err
  }
})
