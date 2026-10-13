# Changelog

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
