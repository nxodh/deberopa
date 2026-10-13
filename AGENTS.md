# Vedecaps

An AI coding agent for the terminal, written in TypeScript and compiled to single-file executables with Bun. It must keep working on Windows 11 and Debian 13.

## Commands

- Bun is a dev dependency, not a global: always `npx bun ...`.
- Typecheck: `npx tsc --noEmit`
- Tests: `npx bun test` (one file: `npx bun test test/loop.test.ts`)
- Run from source: `npx bun run src/index.ts`
- Build: `npx bun run script/build.ts` (`--all` for every target); smoke test a binary with `npx bun run script/smoke.ts <binary>`
- Terminal UI check against a mock model (POSIX): `python3 script/tui-pty.py`
- Secret scan (also runs in CI): `npx bun run script/scan-secrets.ts`

## Layout

- `src/index.ts`, `src/cli/` command line; `src/tui/` Ink terminal UI; `src/server/` HTTP API
- `src/session/` agent loop (`prompt.ts`), storage, compaction, undo; `src/provider/` model adapters
- `src/tool/` tools; `src/permission/`, `src/agent/`, `src/command/`, `src/skill/`
- `src/mcp/`, `src/lsp/`, `src/format/`, `src/snapshot/`, `src/update/`
- `test/helpers.ts` has the mock OpenAI-compatible server every loop test uses

## Rules

- Style: 2-space indent, no semicolons, double quotes, extensionless relative imports, `import type` for types. Strict TypeScript with `noUncheckedIndexedAccess`.
- Cross-platform: never shell out to POSIX tools (`grep`, `find`, `ls`) from product code; use `path` for paths; tests must not hard-code `/tmp`. Windows `.cmd` shims go through `launchSpec` in `src/util/shell.ts`.
- The UI is strictly monochrome (bold, dim, inverse; no hues). Wrapping and cursor maths use `string-width`, never `.length`.
- The repository is public. Never commit keys, tokens, personal email addresses or machine-specific absolute paths; fixtures use obviously fake values such as `sk-test-not-a-real-key`. Anything that prints configuration or errors goes through `src/util/redact.ts`.
- Tests set `VEDECAPS_HOME` to a temp directory (see `test/setup.ts`) and never call a real model API.
- The system prompt and tool list are part of the provider-side prompt cache: keep them deterministic (no timestamps, stable ordering).
- Ink imports `react-devtools-core` statically; `script/build.ts` stubs it. Build through that script rather than `bun build --compile` directly.
