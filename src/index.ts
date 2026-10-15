import { VERSION } from "./global"
import { helpText, UsageError, type CommandSpec } from "./cli/args"
import { runAndExit } from "./cli/bootstrap"
import { redact } from "./util/redact"

interface Entry {
  spec: CommandSpec
  run(argv: string[]): Promise<number>
}

/** Subcommands, loaded lazily so `deberopa --version` and `run` never pay for the TUI. */
const COMMANDS: Record<string, () => Promise<Entry>> = {
  share: async () => {
    const m = await import("./cli/commands/share")
    return { spec: m.spec, run: m.main }
  },
  plugin: async () => {
    const m = await import("./cli/commands/plugin")
    return { spec: m.spec, run: m.main }
  },
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
  local: async () => {
    const m = await import("./cli/commands/local")
    return { spec: m.spec, run: m.main }
  },
  remote: async () => {
    const m = await import("./cli/commands/remote")
    return { spec: m.spec, run: m.main }
  },
  pr: async () => {
    const m = await import("./cli/commands/pr")
    return { spec: m.spec, run: m.main }
  },
  trust: async () => {
    const m = await import("./cli/commands/trust")
    return { spec: m.spec, run: m.main }
  },
  acp: async () => {
    const m = await import("./cli/commands/acp")
    return { spec: m.spec, run: m.main }
  },
  serve: async () => {
    const m = await import("./cli/commands/serve")
    return { spec: m.spec, run: m.main }
  },
  upgrade: async () => {
    const m = await import("./cli/commands/upgrade")
    return { spec: m.spec, run: m.main }
  },
  uninstall: async () => {
    const m = await import("./cli/commands/uninstall")
    return { spec: m.spec, run: m.main }
  },
}

const SUMMARY: [string, string][] = [
  ["deberopa share [id]", "export HTML or serve an expiring read-only conversation"],
  ["deberopa plugin list|install|remove", "manage version-pinned npm plugins"],
  ["deberopa [project]", "start the terminal UI (default)"],
  ["deberopa run [message..]", "run a prompt non-interactively"],
  ["deberopa auth login|list|logout", "manage provider credentials"],
  ["deberopa models [provider]", "list available models"],
  ["deberopa local [check|pull|status]", "local model servers: status, tool-call check, download a model"],
  ["deberopa remote [add|check|scan|remove]", "model servers on other computers: save, check, find on the network"],
  ["deberopa agent list|create", "list or create agents"],
  ["deberopa session list|delete", "manage saved sessions"],
  ["deberopa export [id]", "export a session as JSON or Markdown"],
  ["deberopa import <file>", "import an exported session"],
  ["deberopa mcp list|add|remove", "manage MCP servers"],
  ["deberopa stats", "token usage and cost"],
  ["deberopa serve", "start the HTTP API server"],
  ["deberopa acp", "run as an Agent Client Protocol server (editors)"],
  ["deberopa upgrade [version]", "update deberopa to the latest release"],
  ["deberopa uninstall", "remove deberopa from this machine"],
  ["deberopa pr <number|url>", "check out a GitHub pull request and review it"],
  ["deberopa trust [path]", "allow a project's config to run commands"],
  ["deberopa debug", "show paths, config and tooling"],
]

function mainHelp(): string {
  const width = Math.max(...SUMMARY.map((r) => r[0].length))
  return [
    `Deberopa ${VERSION} - an AI coding agent for your terminal`,
    "",
    "Usage: deberopa [project] [options]",
    "       deberopa <command> [options]",
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
    "  -h, --help               show help (also: deberopa <command> --help)",
    "",
    "Docs: https://github.com/nxodh/deberopa",
  ].join("\n")
}

async function main(argv: string[]): Promise<number> {
  const first = argv[0]
  void import("./update/update").then((m) => m.cleanupOldBinary()).catch(() => {})
  if (first === "--version" || first === "-v" || first === "version") {
    process.stdout.write(VERSION + "\n")
    return 0
  }
  if (first === "--help" || first === "-h" || first === "help") {
    if (first === "help" && argv[1] && COMMANDS[argv[1]]) return main([argv[1], "--help"])
    process.stdout.write(mainHelp() + "\n")
    return 0
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
    throw new UsageError(`Unknown command "${first}". Run \`deberopa --help\` to see what is available.`)
  }
  const tui = await import("./cli/commands/tui")
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(mainHelp() + "\n")
    return 0
  }
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
      process.stderr.write(`${redact(err.message)}\n\nRun \`deberopa --help\` for usage.\n`)
      return 2
    }
    throw err
  }
})
