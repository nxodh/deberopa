# Changelog

## Unreleased

- Model servers on other computers: `deberopa remote` saves a host (`add <name> <host:port> [--key] [--ca file]`), checks it (`check`: answers, kind, models, latency, key or certificate problems with a fix) and looks for servers on this network (`scan`, only when asked, sends no key, private addresses only). A saved host is a provider marked `"remote": true` in the global config; its key is kept in the credential store. Files, tools and the session stay on this computer; only inference is remote. The server has the same under `/remote` (`GET`, `POST`, `POST /remote/check`, `POST /remote/scan`, `DELETE /remote/<id>`).
- Seeing and undoing what the agent changed: `GET /snapshot/diff?hash=…[&file=…]` (unified diff since the snapshot of a step), `POST /snapshot/revert` (put chosen files back; files that did not exist are removed) and `GET /snapshot/status`.
- Terminals: `GET|POST /pty`, `POST /pty/<id>/input`, `POST /pty/<id>/resize`, `DELETE /pty/<id>` with `pty.data` / `pty.exit` events. The user's own shell in the project folder; a real pseudo-terminal through Bun, or plain pipes where Bun cannot give one (reported as `pty: false`).
- An Ollama configured only by address now gets its model list from its own API (before, such a provider had no models until they were written into the config).
- Deberopa Desktop is being rebuilt as an agent-first app (`app/`, see `docs/desktop-v2.md`); the Code - OSS based beta is superseded. So far: projects and sessions with tabs, conversation with tool cards and permissions, a models and servers page (this computer, other computers, tool-call check, model download), a file tree and a code editor tab (syntax highlighting, search, save, picks up changes the agent makes), a diff tab for the agent's changes with revert, terminal tabs (xterm.js), every tab kept alive when you switch (an unsaved edit or a running shell is not lost), and the Deberopa icon rebuilt from the logo.

## 0.3.0-beta.1

**Beta.** The first release that includes Deberopa Desktop. It is a GitHub pre-release: `install.sh`, `install.ps1` and `deberopa upgrade` keep installing the last full release (0.2.0). Install a beta explicitly with `DEBEROPA_VERSION=v0.3.0-beta.1`. The full 0.3.0 follows once the owner has tested it.

Goal, for the CLI and Deberopa Desktop alike: make local LLMs as comfortable as possible as a coding agent. Hosted models stay supported; local ones come first.

- Local servers: `deberopa local` (and `/local` in the terminal UI, `GET /local`) shows what is running and, for what is not, the command that starts it (`opereta serve start`, `ollama serve`, `llama-server … --jinja`, LM Studio, vLLM).
- Tool-call check: `deberopa local check [provider/model]`, `/toolcheck` and `POST /local/toolcheck` ask the model once to call a tool and say whether it works, was recovered from text, or fails. It now covers Ollama's native API too (before, `debug local` skipped it).
- Model downloads: `deberopa local pull <model>`, `/pull` and `POST /local/pull` download into a local Ollama with progress (`local.pull` events). Only an Ollama on this machine or its network; names are validated.
- Speed and slots: the status bar shows tokens per second (the server's own timing when it reports one: Ollama `eval_duration`, llama.cpp `timings`; otherwise `~` from elapsed time), `slots busy/total` while a turn runs on a llama.cpp / Opereta server with `/slots`, and `compact` when the short prompt is in use. `deberopa local status` explains why.
- Tool calls the model wrote as text and Deberopa recovered are marked `viaText` on the tool part.
- First run: with nothing chosen, a model on a local server is the default before a hosted one; with no server at all, the start-up hints appear instead of a key prompt.
- HTTP API for Deberopa Desktop: `GET /local`, `POST /local/toolcheck`, `GET /local/slots`, `POST /local/pull`, `GET|PUT|DELETE /auth` (names only, keys are never returned), `GET|POST|DELETE /trust`, `GET /skill`, `GET /stats`; `GET /provider` carries each model's `mode`.
- `deberopa stats` and the API share one implementation (`src/session/stats.ts`).
- Deberopa Desktop (in development, `desktop/`): pinned Code - OSS build without Copilot, a built-in conversation panel with permission prompts, pickers, local-model card, tool check, downloads, speed and slots. Not released yet; it ships together with the CLI.

## 0.2.0

Vedecaps is now **Deberopa**. Entries below this one keep the old name on purpose: they describe what shipped under it.

- 이름 변경 (Rename): the executable is `deberopa`, the config file is `deberopa.json` (`~/.config/deberopa/`, `%APPDATA%\deberopa` on Windows), the project folder is `.deberopa/`, environment variables are `DEBEROPA_*`, the release assets are `deberopa-<target>.tar.gz`/`.zip` (each holds only the executable), the SDKs, the GitHub Action and the VS Code extension use the new name, and the logo is the new "D" mark.
- Migration: on the first run, when the new settings folder does not exist and the old one does, settings, saved logins, sessions and trusted projects are copied over (the old folders are left in place and never written to again). A project's old-named config file and `.vedecaps` folder are still read, and a new-named file wins. The old `VEDECAPS_*` environment variable names are read for this release and print a one-line deprecation notice; they will stop working later.
- Opereta 인식 (Opereta recognition): the model-server OS is recognised by `GET /opereta/info` (sent without credentials) and the `X-Opereta` response header, shown as `Opereta <version>` with its slots by `deberopa debug local`, and its slot count sets `options.max_concurrency` as before. The key variable is `OPERETA_API_KEY` (then `LLAMA_API_KEY`). Certificate errors point at `opereta tls ca`, `opereta tls status` and `opereta tls renew`. Nothing recognises the previous OS name any more: no alias, no fallback.
- `deberopa debug local` suggests `opereta connect deberopa --write --mcp` for an Opereta server that is only auto-detected.
- An installed `vedecaps` 0.1.x that runs `vedecaps upgrade` looks for the old asset names and stops with a download error without changing anything; install Deberopa with the install script instead (see the README).

## 0.1.5

- VE2: `provider.<id>.options.ca` (PEM file path, list of paths, or inline PEM) makes a provider trust a private certificate authority for its HTTPS server. `~` is the home directory; a relative path is relative to the config file it was written in (`VEDECAPS_CONFIG_CONTENT`: the current directory). The file is read when providers are built. A provider with `ca` trusts only those authorities, for chat, model listing, `/diparnux/info` and the tool check. A file that is missing, unreadable or not a PEM certificate makes the provider unusable (shown by `vedecaps debug` and in errors) and never falls back to the system store. There is no option to disable certificate or host-name verification.
- Certificate failures now say what to do (untrusted CA, wrong name, expired, bad `ca` file) and are not retried. Redirects are still never followed.
- `options.ca` in a project that is not trusted is ignored and listed as blocked; the global config's value is kept.
- `vedecaps debug local` reports certificate state and the CA's SHA-256 fingerprint for HTTPS providers, and `--check-tools` and the slot limit work over HTTPS.
- Test certificates for the TLS tests live in `test/fixtures/tls/` (marked TEST ONLY; the secret scan allows private keys only there).

## 0.1.4

- Local servers that need an API key are detected: `DIPARNUX_API_KEY` (then `LLAMA_API_KEY`) is sent as a bearer token to the detected llama.cpp address and to configured local providers. A 401/403 from a server that is there is now reported by `vedecaps debug local` instead of looking like nothing was found. Detection probes do not follow redirects.
- Asking for a model on a server that refused the probe now says it needs an API key instead of "Unknown provider".
- Diparnux gateways are recognised (`X-Diparnux` header or `GET /diparnux/info`, sent without credentials). Their slot count and per-slot context are read and validated; the smaller of the model's and the slot's window is used, and a `limit.context` in the config always wins. Hosted APIs are never asked.
- `provider.<id>.options.max_concurrency` (1-64) limits simultaneous model requests per server. Waiting requests leave the queue when aborted, slots are always returned (success, error, early close), and titles/summaries are served after real work. A Diparnux gateway with a fixed slot count sets it automatically when the config does not; invalid values are ignored and shown by `vedecaps debug`. Unset means unlimited, as before.
- `vedecaps debug local` shows server state, slots and context per slot, and `--check-tools` sends one request per server to see whether tool calling works (`ok`, `recovered` from text, or `failed`).

## 0.1.3

- The interactive terminal UI uses the full terminal in an alternate screen, with a fixed prompt/status bar and a scrollable conversation. PageUp/PageDown and Ctrl+Home/End navigate history; terminal resize, exit and external editor handoff restore the appropriate screen.

## 0.1.2

- Update VS Code packaging to vsce 4, removing the vulnerable braces dependency chain; extension packaging requires Node.js 22+.

- Automatic Git status disables repository fsmonitor execution; plan/explore shell commands require permission instead of relying on command-name allowlists.

- Fix project trust bypasses in Markdown agents/commands, file/env substitutions, relative global plugins, and automatic formatters/LSPs. Shell substitutions follow session permissions and cannot be introduced through arguments.
- Harden server origins, hosts, body limits, response redaction and non-local authentication; prevent credential-bearing redirects and legacy MCP cross-origin endpoints.
- Resolve symlinks for external-path and sensitive-file permissions. Imported sessions discard machine-local snapshots/native replay data and receive fresh part IDs; snapshot restores are project-bounded and ignore global Git hooks/filters.
- Fix automatic compaction when the configured output limit fills a small context window.
- Configurable terminal prompt key bindings, including model/session shortcuts.
- Explicit version-pinned npm plugins with installation confirmation, disabled lifecycle scripts, lockfiles and no automatic startup installation.
- Dependency-free Python and Go HTTP/SSE SDKs. Fix JavaScript SDK server password propagation.
- Additional consent-based LSP installers: clangd, ZLS, Ruby LSP and LuaLS. Official binary downloads verify published SHA-256 and reject unsafe archive entries.
- Linux musl x64/arm64 executables, libc-aware installers/upgrade, Alpine CI and release verification. Alpine requires libstdc++/libgcc.
- Read-only HTML session sharing and separate expiring self-hosted viewers, with no third-party uploads.
- Subscription-account OAuth and MCP OAuth remain unimplemented under the conservative service-policy review. Bedrock, Vertex and Azure remain outside this change.

- Status bar shows the git branch, number of changed files and ahead/behind counts.
- `/undo` now says when it cannot restore files (not a git repository, git missing, snapshots off) and warns once when an edited file is git-ignored.
- `vedecaps pr <number|url> [message]` checks out a GitHub pull request through `gh` and reviews it read-only, or works on it when given a message. Refuses uncommitted changes; the PR description is passed as untrusted text.
- System prompt guidance for commits and pull requests (inspect status/diff/log first, stage specific files, no `--no-verify`, `gh pr create`).
- GitHub Action: `commit`, `branch`, `commit-message`, `pull-request`, `pr-title`, `pr-base`, `github-token` inputs and `changed`, `branch`, `commit`, `pull-request-url` outputs.

## 0.1.1

- Local models: Ollama, LM Studio, llama.cpp and vLLM are detected automatically, with each model's real context window and capabilities (`vedecaps debug local`).
- Ollama native API with an explicit `num_ctx` (default: the model's maximum, capped at 16,384), instead of the OpenAI-compatible API that silently truncates prompts to 2-4K tokens.
- Compact prompt and core-tools-only mode for small context windows and small models (about 4,800 -> 1,600 tokens per request measured on qwen3:0.6b).
- Recovery of tool calls written as text (Hermes/Qwen, Qwen3-Coder, Mistral, JSON fences) and of `<think>` tags.
- Context usage and auto-compaction stay correct when Ollama under-reports cached prompt tokens.
- Providers configured by URL only list their models from `/models`.
- `patch` tool: create, update, move and delete several files with one `*** Begin Patch` block; atomic, with whitespace-tolerant matching.
- `websearch` tool through Exa (free shared limit, or your own `EXA_API_KEY`). Asks before sending a query.
- Missing language servers (TypeScript, Pyright, gopls, rust-analyzer) can be installed on request into Vedecaps' own data directory, with confirmation.
- JavaScript SDK (`@vedecaps/sdk`) for the HTTP API, including event streaming and spawning a server.
- `vedecaps acp`: Agent Client Protocol server for Zed and other editors.
- GitHub Action (`nxodh/vedecaps`) and example workflows for PR review and `/vedecaps` comments.
- Plugins: local JS/TS files that add tools and hook `tool.execute.before/after`, `chat.system` and events. Loaded from the user's config directory, the `plugin` setting, and trusted projects; work in the compiled binary without Node or Bun.
- Project trust: parts of a repository's own config that start programs, route requests or API keys elsewhere, or allow actions without asking are ignored until `vedecaps trust` (or `/trust`). `VEDECAPS_TRUST_PROJECT=1` vouches for a checkout in CI.
- VS Code extension (`ide/vscode`): opens Vedecaps beside the editor and types `@file#L10-20` references into its prompt. Attached to the release as a `.vsix`.
- `@file#L10-20` mentions attach only those lines.

### Changed

- A project's `vedecaps.json` can no longer start MCP servers, formatters or language servers, change provider endpoints, or add allow-rules until the project is trusted. Existing setups need a one-time `vedecaps trust`.

## 0.1.0

First release.

- Terminal UI with a monochrome design that follows the logo: streamed Markdown, per-tool views, a multi-line editor with CJK/emoji and IME support, `@file` and `/command` completion, `!shell` mode, pickers for models, sessions, agents and themes, permission prompts, message queueing.
- Agents `build` and `plan`, subagents `general` and `explore`, and custom agents from Markdown files or config.
- Tools: `bash`, `read`, `edit`, `multiedit`, `write`, `glob`, `grep`, `list`, `webfetch`, `todowrite`, `todoread`, `task`, `skill`.
- Providers: Anthropic (adaptive thinking, prompt caching) and any OpenAI-compatible API (OpenAI, Google Gemini, OpenRouter, xAI, Groq, DeepSeek, Mistral, Ollama, LM Studio, ...), with the model catalog from models.dev.
- Sessions stored on disk with resume, undo/redo including file restore, automatic compaction, fork, and JSON/Markdown export and import.
- Permission rules (`allow` / `ask` / `deny`) with wildcard patterns.
- Custom commands, skills, MCP servers (stdio and HTTP), LSP diagnostics and automatic formatting.
- CLI: `run`, `auth`, `models`, `agent`, `session`, `export`, `import`, `mcp`, `stats`, `serve`, `upgrade`, `uninstall`, `debug`.
- HTTP API server with a server-sent event stream.
- Single-file executables for Linux (x64, arm64), Windows (x64) and macOS (arm64, x64); `install.sh` and `install.ps1` installers and `vedecaps upgrade`, all verifying SHA-256 checksums.
