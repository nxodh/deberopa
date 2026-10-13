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

The installers verify the release's SHA-256 checksum, install to `~/.vedecaps/bin` (`%LOCALAPPDATA%\vedecaps\bin` on Windows) and add it to your PATH. Set `VEDECAPS_VERSION`, `VEDECAPS_INSTALL_DIR` or `VEDECAPS_NO_MODIFY_PATH=1` to change that. musl x64/arm64 builds are available from 0.1.2. Alpine requires libstdc++ and libgcc (apk add --no-cache libstdc++ libgcc).

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
- **Local models**: Ollama, LM Studio, llama.cpp and vLLM are detected automatically (see `vedecaps debug local`; `--check-tools` sends one request per server to test tool calling). Servers that need an API key (llama-server `--api-key`, Diparnux) are detected when `DIPARNUX_API_KEY` or `LLAMA_API_KEY` is set, and a 401 is reported instead of "nothing found". A Diparnux gateway is recognised by its `X-Diparnux` header or `/diparnux/info`, and its per-slot context fills in providers that have no `limit.context` of their own. `provider.<id>.options.max_concurrency` (1-64) caps simultaneous requests to a server so subagents queue instead of earning 429s; titles yield to real work, aborts leave the queue immediately, and a gateway with a fixed slot count sets it automatically (the value you write always wins). Ollama is driven through its native API so the context window is set explicitly instead of being silently cut to 2-4K tokens; small models get a short prompt and the core tools only; tool calls written as text and `<think>` tags are recovered.
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
- **SDK** (`sdk/js`), **ACP server** (`vedecaps acp`, for Zed and other editors), **VS Code extension** (`ide/vscode`), **GitHub Action** (`uses: nxodh/vedecaps@v0.1.3`).
- `@file#L10-20` mentions attach only those lines.

The Korean README documents all of these in detail.

## Git and GitHub

- **Status bar**: `⎇ branch · N changed · ↑ahead ↓behind` in git repositories (read-only, refreshed after each turn and edit).
- **Undo**: files are restored from snapshots kept in a private store, never touching your `.git`. When that is impossible (not a git repo, no git, `"snapshot": false`) or for git-ignored files, Vedecaps now says so instead of silently only rewinding the conversation.
- **Commits and PRs**: only on request; follows the repository's message style, stages specific files, never skips hooks, opens PRs with `gh pr create`.
- **`vedecaps pr <number|url> [message]`**: checks out a pull request with `gh` and reviews it read-only (or works on it when you give a message). Refuses a dirty tree; treats the author's description as untrusted.
- **GitHub Action**: new inputs `commit`, `branch`, `commit-message`, `pull-request`, `pr-title`, `pr-base`, `github-token`; outputs `changed`, `branch`, `commit`, `pull-request-url`.

## Not yet

Central hosted sharing, subscription-account OAuth and MCP OAuth (conservatively deferred pending service-specific authorization review), and Bedrock / Vertex / Azure authentication (outside the current scope). See [the authentication policy review](docs/oauth-policy.md).

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

## Added in 0.1.3

The terminal UI uses the full terminal screen with a fixed prompt/status bar, PageUp/PageDown history navigation, Ctrl+Home/End, and terminal restoration on exit or external-editor handoff. Update with `vedecaps upgrade`.

## Added in 0.1.2

- Configurable prompt key bindings under `keybinds`: comma-separated alternatives, ctrl/alt/shift modifiers, and `none` to disable. For example, `{"submit":"ctrl+g","newline":"enter","models":"ctrl+p"}`. `/help` shows the configured bindings; restart after editing config. User overrides win over conflicting defaults. Dialog selection keys retain their defaults.
- Explicit, exact-version npm plugins: `vedecaps plugin install name@1.2.3`, `list`, and `remove`. Review the code first: plugins run with your full privileges. Non-interactive installs need `--yes`. Lifecycle scripts are disabled, lockfiles retained, and URL/file/git/range specs rejected. Config uses `npm:name@1.2.3`; startup never installs packages.
- Dependency-free [Python SDK](sdk/python/README.md) and [Go SDK](sdk/go/README.md). These are checkout packages, not published registry releases. Remote SDK connections require HTTPS.
- Consent-based installers for clangd, ZLS, Ruby LSP and LuaLS. Official binary downloads require a matching SHA-256; ZLS matches the installed stable Zig major/minor. Unsupported official platforms fall back to manual system installation. Ruby/RubyGems are required for Ruby LSP and dependencies may compile native code. clangd and LuaLS on Alpine should use system packages if upstream supplies only glibc builds.
- Linux musl x64/arm64 builds, libc-aware installation and upgrade. Alpine needs libstdc++/libgcc, which the installer does not silently install.
- `/share [file.html]` and `vedecaps share [id] -o session.html` export escaped, read-only HTML without tools, reasoning or attachment contents. Review private content yourself before sharing. `--serve --yes --ttl 3600` starts a separate expiring viewer on loopback; Non-loopback binding is rejected; remote access requires a separately configured HTTPS reverse proxy. Links grant read access to anyone possessing them; Ctrl+C revokes sharing. No hosted service upload occurs.
- Untrusted projects cannot load executable command/agent definitions, expand local files/env vars, or auto-run formatters/LSPs. Shell substitutions follow session permissions. Non-local agent APIs require a password; cross-origin and redirect-based credential forwarding are rejected.
