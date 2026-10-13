export const INIT_TEMPLATE = `Analyse this codebase and create (or improve, if it already exists) an AGENTS.md file in the project root. AGENTS.md is read by AI coding agents at the start of every session, so it should contain only what an agent cannot quickly work out for itself.

Steps:
1. Explore the repository: the top-level layout, package/build manifests, CI configuration, test setup, linters and formatters, and any existing AGENTS.md, CLAUDE.md, .cursorrules, .github/copilot-instructions.md or README.
2. Find out how the project is built, tested, linted and run (the exact commands), and how to run a single test.
3. Note the architecture at a level that helps navigation: main directories, entry points, how the pieces connect.
4. Note the code style and conventions that are actually used, and non-obvious gotchas (generated files, required environment variables, platform quirks, things that must not be edited).

Write AGENTS.md as concise Markdown with sections such as: Commands, Architecture, Code style, Testing, Gotchas. Keep it under about 150 lines, prefer concrete commands and paths over prose, and do not include generic advice like "write clean code". If an AGENTS.md already exists, keep what is accurate, fix what is outdated and add what is missing rather than rewriting it from scratch. If a CLAUDE.md exists with useful content, fold it in.

When you are done, tell me briefly what you wrote.

$ARGUMENTS`

export const REVIEW_TEMPLATE = `You are reviewing code changes. Find real problems: bugs, security issues, missing error handling, broken edge cases, regressions and missing tests. Do not nitpick style that a formatter would fix.

What to review depends on the input: "$ARGUMENTS"
- Empty: the uncommitted changes. Run \`git status --short\`, \`git diff\` and \`git diff --cached\`, and read any untracked files that matter.
- A commit hash: run \`git show <hash>\`.
- A branch name: run \`git diff <branch>...HEAD\` (and \`git log <branch>..HEAD --oneline\`).
- A pull request number or URL: use \`gh pr diff <number>\` if the gh CLI is available.

Read the surrounding code, not just the diff, before judging a change. Then report:
1. A short summary of what the change does.
2. Findings ordered by severity, each with file:line, what is wrong, why it matters, and a concrete fix. Say explicitly when you are not sure.
3. If you found nothing significant, say so plainly instead of inventing issues.

Do not modify any files.`
