# Changelog

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
