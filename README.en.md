<p align="center">
  <img src="assets/logo.png" alt="Deberopa" width="140">
</p>

<h1 align="center">Deberopa</h1>

<p align="center">An AI coding agent for your terminal · <a href="README.md">한국어</a></p>

Deberopa reads, edits and runs code from your terminal. It is the same kind of tool as [OpenCode](https://opencode.ai) and ships as a single executable for Windows 11 and Debian 13 class Linux (macOS builds are provided too).

**Goal**: Deberopa (the CLI and Deberopa Desktop alike) aims to be the most comfortable way to use **local LLMs as a coding agent**. Hosted models are supported too, but features and conveniences are prioritised for local ones: it finds local servers, checks that a model can call tools, shrinks the prompt for small models, shows speed, slots and context, and downloads Ollama models for you.

## Install

Linux / macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/nxodh/deberopa/main/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/nxodh/deberopa/main/install.ps1 | iex
```

The installers verify the release's SHA-256 checksum, install to `~/.deberopa/bin` (`%LOCALAPPDATA%\deberopa\bin` on Windows) and add it to your PATH. Set `DEBEROPA_VERSION`, `DEBEROPA_INSTALL_DIR` or `DEBEROPA_NO_MODIFY_PATH=1` to change that. musl x64/arm64 builds are available from 0.1.2. Alpine requires libstdc++ and libgcc (apk add --no-cache libstdc++ libgcc).

Update with `deberopa upgrade`; remove with `deberopa uninstall`.

## Quick start

```sh
deberopa auth login        # store a provider API key (or export ANTHROPIC_API_KEY, OPENAI_API_KEY, ...)
cd my-project
deberopa                   # terminal UI
deberopa run "explain what this repo does"     # non-interactive
```

Run `/init` once per project to generate an `AGENTS.md` that is given to the agent at the start of every session.

## Deberopa Desktop

A desktop app for people who prefer a window to a terminal: a Code - OSS based editor with a conversation panel (permission prompts, tool cards, sessions, a local-models card). It bundles the `deberopa` command of the same version, so there is nothing else to install, and it is released together with the CLI under the same number.

| Target | File | Run |
|---|---|---|
| Debian 13 / Opereta (x86-64) | `deberopa-desktop-linux-x64.tar.gz` | unpack, then `deberopa-desktop-<version>-linux-x64/deberopa-desktop` |
| Windows 11 (x86-64) | `deberopa-desktop-windows-x64.zip` | unpack, then `Deberopa Desktop.exe` |

- There is no installer and no auto-update yet; unpack a newer release to update.
- **It is not signed.** Windows may show SmartScreen or Smart App Control may block it. Check `checksums.txt` (SHA-256) and the GitHub build attestation (`gh attestation verify <file> --repo nxodh/deberopa`).
- If it exits at once on Debian 13 because of Electron's sandbox, start it with `--no-sandbox`, or make `chrome-sandbox` owned by root with mode 4755.
- No Microsoft marketplace or telemetry, and the Copilot extension is removed. Extensions: built-in ones and installing a VSIX directly.
- Source and build: `desktop/`; design: [docs/desktop-design.md](docs/desktop-design.md).

## What is in 0.1

- **Terminal UI**: streamed Markdown, per-tool views (diffs, command output, todo lists, subagent activity), multi-line editor with correct CJK/emoji handling and IME cursor placement, `@file` and `/command` completion, `!shell` mode, model / session / agent / theme pickers, permission prompts, message queueing, monochrome themes.
- **Agents**: `build`, read-only `plan`, subagents `general` and `explore`; your own agents as Markdown files or config.
- **Tools**: `bash`, `read`, `edit`, `multiedit`, `write`, `patch`, `glob`, `grep`, `list`, `webfetch`, `todowrite`/`todoread`, `task`, `skill`.
- **Local models**: Ollama, LM Studio, llama.cpp and vLLM are detected automatically (see `deberopa debug local`; `--check-tools` sends one request per server to test tool calling). Servers that need an API key (llama-server `--api-key`, Opereta) are detected when `OPERETA_API_KEY` or `LLAMA_API_KEY` is set, and a 401 is reported instead of "nothing found". A Opereta gateway is recognised by its `X-Opereta` header or `/opereta/info`, and its per-slot context fills in providers that have no `limit.context` of their own. `provider.<id>.options.max_concurrency` (1-64) caps simultaneous requests to a server so subagents queue instead of earning 429s; titles yield to real work, aborts leave the queue immediately, and a gateway with a fixed slot count sets it automatically (the value you write always wins). Ollama is driven through its native API so the context window is set explicitly instead of being silently cut to 2-4K tokens; small models get a short prompt and the core tools only; tool calls written as text and `<think>` tags are recovered.
- **Providers**: Anthropic natively; OpenAI, Google Gemini, OpenRouter, xAI, Groq, DeepSeek, Mistral and any OpenAI-compatible endpoint (Ollama, LM Studio, proxies). Model catalog from [models.dev](https://models.dev).
- **Sessions**: saved on disk, resume, undo/redo with file restore, automatic compaction, fork, export/import.
- **Permissions**: `allow` / `ask` / `deny` per tool with wildcard patterns for shell commands.
- **Extensibility**: custom commands, skills (`SKILL.md`), MCP servers (stdio and HTTP), LSP diagnostics and formatters when the tools are already installed.
- **CLI and server**: `run`, `auth`, `models`, `agent`, `session`, `export`, `import`, `mcp`, `stats`, `serve` (HTTP API + SSE), `upgrade`, `uninstall`, `debug`.

The full reference (configuration, permissions, commands, HTTP routes) is in the [Korean README](README.md); every CLI command also documents itself with `--help`, and the config file has a JSON Schema at [`config.schema.json`](config.schema.json).

## Also in 0.1.1

- **Web search** through Exa (asks before sending a query; `EXA_API_KEY` lifts the shared free limit).
- **`patch` tool**: multi-file create/update/move/delete in one atomic `*** Begin Patch` block.
- **Language servers on request**: TypeScript, Pyright, gopls and rust-analyzer are offered for installation (with consent, into Deberopa' own directory).
- **Project trust**: an untrusted repository's config cannot start programs, route requests/keys elsewhere, or silence permission prompts until you run `deberopa trust`.
- **Plugins**: local JS/TS files adding tools and hooks (`tool.execute.before/after`, `chat.system`, `event`); work in the compiled binary without Node or Bun.
- **SDK** (`sdk/js`), **ACP server** (`deberopa acp`, for Zed and other editors), **VS Code extension** (`ide/vscode`), **GitHub Action** (`uses: nxodh/deberopa@v0.3.0`).
- `@file#L10-20` mentions attach only those lines.

The Korean README documents all of these in detail.

## Git and GitHub

- **Status bar**: `⎇ branch · N changed · ↑ahead ↓behind` in git repositories (read-only, refreshed after each turn and edit).
- **Undo**: files are restored from snapshots kept in a private store, never touching your `.git`. When that is impossible (not a git repo, no git, `"snapshot": false`) or for git-ignored files, Deberopa now says so instead of silently only rewinding the conversation.
- **Commits and PRs**: only on request; follows the repository's message style, stages specific files, never skips hooks, opens PRs with `gh pr create`.
- **`deberopa pr <number|url> [message]`**: checks out a pull request with `gh` and reviews it read-only (or works on it when you give a message). Refuses a dirty tree; treats the author's description as untrusted.
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

## Added in 0.2.0

The project was renamed from Vedecaps to **Deberopa**: executable `deberopa`, config `~/.config/deberopa/deberopa.json` (`%APPDATA%\deberopa` on Windows), project folder `.deberopa/`, environment variables `DEBEROPA_*`, release assets `deberopa-<target>.tar.gz`/`.zip`.

- On the first run, if the new settings folder does not exist and the old one does, settings, saved logins, sessions and trusted projects are **copied** over; the old folders are left alone and not used again. A project's old-named config file and folder are still read and the new name wins. Old `VEDECAPS_*` variables are read for this release and print a one-line deprecation notice.
- The model-server OS **Opereta** is recognised by `GET /opereta/info` and the `X-Opereta` header (`deberopa debug local` shows `Opereta <version>` and its slots); the key variable is `OPERETA_API_KEY`, and TLS errors point at `opereta tls ca`, `opereta tls status` and `opereta tls renew`. `opereta connect deberopa --write --mcp` writes the provider settings.
- An installed `vedecaps` 0.1.x cannot upgrade itself to this release (it looks for the old asset names and stops without changing anything); install `deberopa` with the install script.

## Added in 0.1.5

`provider.<id>.options.ca` trusts a private certificate authority for one HTTPS server (for Opereta: the file `opereta tls ca` prints). It is a PEM file path, a list of paths, or inline PEM; `~` is the home directory and relative paths are relative to the config file the setting is in. Verification and host-name checks cannot be turned off.

```jsonc
{ "provider": { "opereta": { "api": "https://spark.local:8444/v1", "options": { "ca": "~/.config/deberopa/opereta-ca.pem" } } } }
```

- A provider with `ca` trusts **only** those authorities (Bun's `tls.ca` replaces the system store), for chat requests, model listing, `/opereta/info` and the tool check alike.
- A `ca` file that is missing, unreadable or not a PEM certificate makes that provider **unusable**, with the reason in `deberopa debug` and in errors. There is no silent fall back to the system store.
- A project that is not trusted cannot set `options.ca`; it is ignored and listed by `deberopa debug`.
- HTTP to HTTPS redirects are still never followed, and auto-detected loopback servers stay on plain `http://127.0.0.1`.
- If the CA uses name constraints, constrain DNS names only: Bun cannot verify a leaf with an IP address name under a CA that has IP constraints (`UNSUPPORTED_CONSTRAINT_TYPE`).

| Message | Meaning | Fix |
|---|---|---|
| `The certificate of … is not trusted` | the server's CA is unknown | set `options.ca` to the server's CA file (Opereta: `opereta tls ca`) |
| `… is not signed by a CA listed in …options.ca` | that CA did not sign this server's certificate | check you have the right CA file |
| `The certificate does not cover <host>` | the name or address you used is not in the certificate | connect with a listed name (Opereta: `opereta tls status`) |
| `The certificate of … has expired` | validity ended | renew on the server (`opereta tls renew`), check both clocks |
| `cannot read … The provider is not used…` | problem with the `ca` file | check the path and the PEM format |

`deberopa debug local` shows `TLS: certificate accepted, trusted by ca.pem` and the CA's SHA-256 fingerprint (`AA:BB:…`) for providers with `ca` or an HTTPS address; compare it with what the server prints.

## Added in 0.1.4

Local servers that need an API key (llama-server `--api-key`, Opereta) are detected with `OPERETA_API_KEY` or `LLAMA_API_KEY`, and a refusal is reported instead of "nothing found". Opereta gateways are recognised and their slots read. `options.max_concurrency` caps simultaneous requests per server, and `deberopa debug local --check-tools` tests tool calling. Update with `deberopa upgrade`.

## Added in 0.1.3

The terminal UI uses the full terminal screen with a fixed prompt/status bar, PageUp/PageDown history navigation, Ctrl+Home/End, and terminal restoration on exit or external-editor handoff. Update with `deberopa upgrade`.

## Added in 0.1.2

- Configurable prompt key bindings under `keybinds`: comma-separated alternatives, ctrl/alt/shift modifiers, and `none` to disable. For example, `{"submit":"ctrl+g","newline":"enter","models":"ctrl+p"}`. `/help` shows the configured bindings; restart after editing config. User overrides win over conflicting defaults. Dialog selection keys retain their defaults.
- Explicit, exact-version npm plugins: `deberopa plugin install name@1.2.3`, `list`, and `remove`. Review the code first: plugins run with your full privileges. Non-interactive installs need `--yes`. Lifecycle scripts are disabled, lockfiles retained, and URL/file/git/range specs rejected. Config uses `npm:name@1.2.3`; startup never installs packages.
- Dependency-free [Python SDK](sdk/python/README.md) and [Go SDK](sdk/go/README.md). These are checkout packages, not published registry releases. Remote SDK connections require HTTPS.
- Consent-based installers for clangd, ZLS, Ruby LSP and LuaLS. Official binary downloads require a matching SHA-256; ZLS matches the installed stable Zig major/minor. Unsupported official platforms fall back to manual system installation. Ruby/RubyGems are required for Ruby LSP and dependencies may compile native code. clangd and LuaLS on Alpine should use system packages if upstream supplies only glibc builds.
- Linux musl x64/arm64 builds, libc-aware installation and upgrade. Alpine needs libstdc++/libgcc, which the installer does not silently install.
- `/share [file.html]` and `deberopa share [id] -o session.html` export escaped, read-only HTML without tools, reasoning or attachment contents. Review private content yourself before sharing. `--serve --yes --ttl 3600` starts a separate expiring viewer on loopback; Non-loopback binding is rejected; remote access requires a separately configured HTTPS reverse proxy. Links grant read access to anyone possessing them; Ctrl+C revokes sharing. No hosted service upload occurs.
- Untrusted projects cannot load executable command/agent definitions, expand local files/env vars, or auto-run formatters/LSPs. Shell substitutions follow session permissions. Non-local agent APIs require a password; cross-origin and redirect-based credential forwarding are rejected.
