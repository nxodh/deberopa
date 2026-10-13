<p align="center">
  <img src="assets/logo.png" alt="Vedecaps" width="140">
</p>

<h1 align="center">Vedecaps</h1>

<p align="center">An AI coding agent for your terminal · <a href="README.md">한국어</a></p>

Vedecaps reads, edits and runs code from your terminal. It is the same kind of tool as [OpenCode](https://opencode.ai) and ships as a single executable for Windows 11 and Debian 13 class Linux (macOS builds are provided too).

## Install

Linux / macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/nxodh/vedecaps/main/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/nxodh/vedecaps/main/install.ps1 | iex
```

The installers verify the release's SHA-256 checksum, install to `~/.vedecaps/bin` (`%LOCALAPPDATA%\vedecaps\bin` on Windows) and add it to your PATH. Set `VEDECAPS_VERSION`, `VEDECAPS_INSTALL_DIR` or `VEDECAPS_NO_MODIFY_PATH=1` to change that. musl-based distributions (Alpine) are not supported yet.

Update with `vedecaps upgrade`; remove with `vedecaps uninstall`.

## Quick start

```sh
vedecaps auth login        # store a provider API key (or export ANTHROPIC_API_KEY, OPENAI_API_KEY, ...)
cd my-project
vedecaps                   # terminal UI
vedecaps run "explain what this repo does"     # non-interactive
```

Run `/init` once per project to generate an `AGENTS.md` that is given to the agent at the start of every session.

## What is in 0.1

- **Terminal UI**: streamed Markdown, per-tool views (diffs, command output, todo lists, subagent activity), multi-line editor with correct CJK/emoji handling and IME cursor placement, `@file` and `/command` completion, `!shell` mode, model / session / agent / theme pickers, permission prompts, message queueing, monochrome themes.
- **Agents**: `build`, read-only `plan`, subagents `general` and `explore`; your own agents as Markdown files or config.
- **Tools**: `bash`, `read`, `edit`, `multiedit`, `write`, `patch`, `glob`, `grep`, `list`, `webfetch`, `todowrite`/`todoread`, `task`, `skill`.
- **Local models**: Ollama, LM Studio, llama.cpp and vLLM are detected automatically (see `vedecaps debug local`). Ollama is driven through its native API so the context window is set explicitly instead of being silently cut to 2-4K tokens; small models get a short prompt and the core tools only; tool calls written as text and `<think>` tags are recovered.
- **Providers**: Anthropic natively; OpenAI, Google Gemini, OpenRouter, xAI, Groq, DeepSeek, Mistral and any OpenAI-compatible endpoint (Ollama, LM Studio, proxies). Model catalog from [models.dev](https://models.dev).
- **Sessions**: saved on disk, resume, undo/redo with file restore, automatic compaction, fork, export/import.
- **Permissions**: `allow` / `ask` / `deny` per tool with wildcard patterns for shell commands.
- **Extensibility**: custom commands, skills (`SKILL.md`), MCP servers (stdio and HTTP), LSP diagnostics and formatters when the tools are already installed.
- **CLI and server**: `run`, `auth`, `models`, `agent`, `session`, `export`, `import`, `mcp`, `stats`, `serve` (HTTP API + SSE), `upgrade`, `uninstall`, `debug`.

The full reference (configuration, permissions, commands, HTTP routes) is in the [Korean README](README.md); every CLI command also documents itself with `--help`, and the config file has a JSON Schema at [`config.schema.json`](config.schema.json).

## Also in 0.1.1

- **Web search** through Exa (asks before sending a query; `EXA_API_KEY` lifts the shared free limit).
- **`patch` tool**: multi-file create/update/move/delete in one atomic `*** Begin Patch` block.
- **Language servers on request**: TypeScript, Pyright, gopls and rust-analyzer are offered for installation (with consent, into Vedecaps' own directory).
- **Project trust**: an untrusted repository's config cannot start programs, route requests/keys elsewhere, or silence permission prompts until you run `vedecaps trust`.
- **Plugins**: local JS/TS files adding tools and hooks (`tool.execute.before/after`, `chat.system`, `event`); work in the compiled binary without Node or Bun.
- **SDK** (`sdk/js`), **ACP server** (`vedecaps acp`, for Zed and other editors), **VS Code extension** (`ide/vscode`), **GitHub Action** (`uses: nxodh/vedecaps@v0.1.1`).
- `@file#L10-20` mentions attach only those lines.

The Korean README documents all of these in detail.

## Not yet

Session sharing, subscription-account OAuth login (deliberately not implemented), Bedrock / Vertex / Azure authentication, npm-packaged plugins, SDKs for other languages, automatic installation of clangd / zls / ruby-lsp / lua-language-server, MCP OAuth, configurable key bindings, musl builds.

## Development

Node.js 22+ is required; Bun is installed as a dev dependency.

```sh
npm ci
npx bun run src/index.ts            # run from source
npx tsc --noEmit && npx bun test    # typecheck and tests
npx bun run script/build.ts --all   # executables for every platform + checksums
```

Pushing a `v*` tag that matches `package.json` builds and publishes a release.

## License

[MIT](LICENSE)
