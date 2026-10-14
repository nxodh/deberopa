import { parse, UsageError, type CommandSpec } from "../args"
import { run } from "../../util/shell"
import { buildPullRequestPrompt, parsePullRequestRef, preparePullRequest, PullRequestError } from "../../git/pr"

export const spec: CommandSpec = {
  usage: "deberopa pr <number|url> [message..] [options]",
  description: "check out a GitHub pull request and review it (or work on it) with the agent",
  options: {
    agent: { type: "string", arg: "name", description: 'agent to use (default: "plan", read-only, for a review; "build" when you give a message)' },
    model: { type: "string", short: "m", arg: "provider/model", description: "model to use" },
    force: { type: "boolean", description: "check out even with uncommitted changes" },
    "no-ui": { type: "boolean", description: "print the answer instead of opening the terminal UI" },
    "print-logs": { type: "boolean", description: "print the log to stderr" },
  },
  examples: [
    "deberopa pr 123",
    "deberopa pr https://github.com/owner/repo/pull/123",
    'deberopa pr 123 "fix the failing test and explain the cause"',
    "deberopa pr 123 --no-ui > review.md",
  ],
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, spec.options!)
  const target = positionals[0]
  if (!target) throw new UsageError("Which pull request? Give a number or URL: deberopa pr 123")
  const ref = parsePullRequestRef(target)
  if (!ref) throw new UsageError(`"${target}" is not a pull request number or URL.`)
  const message = positionals.slice(1).join(" ").trim()

  let meta
  try {
    process.stderr.write(`Checking out pull request #${ref.number}…\n`)
    meta = await preparePullRequest(
      ref,
      {
        gh: (args) => run("gh", args, { cwd: process.cwd(), timeout: 60_000 }),
        git: (args) => run("git", args, { cwd: process.cwd(), timeout: 30_000 }),
      },
      { force: values.force },
    )
  } catch (err) {
    if (err instanceof PullRequestError) {
      process.stderr.write(err.message + "\n")
      return 1
    }
    throw err
  }
  process.stderr.write(`On ${meta.headRefName}: ${meta.title}\n`)

  const prompt = buildPullRequestPrompt(meta, message)
  // a plain review is read-only; when the user asked for changes the agent may edit
  const agent = values.agent ?? (message ? "build" : "plan")
  const common: string[] = ["--agent", agent]
  if (values.model) common.push("-m", values.model)
  if (values["print-logs"]) common.push("--print-logs")

  const interactive = process.stdin.isTTY && process.stdout.isTTY && !values["no-ui"]
  if (interactive) {
    const tui = await import("./tui")
    return tui.main([...common, "-p", prompt])
  }
  const runCommand = await import("./run")
  return runCommand.main([...common, "--title", `PR #${meta.number}: ${meta.title}`.slice(0, 80), "--", prompt])
}
