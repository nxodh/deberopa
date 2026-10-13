import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { Box, Text, useApp, useBoxMetrics, useWindowSize } from "ink"
import { Paths, VERSION } from "../global"
import { project } from "../project"
import { getConfig, readState, writeState } from "../config/config"
import { listAgents, primaryAgents } from "../agent/agent"
import { allProviders, availableProviders, getModel, resetProviders } from "../provider/provider"
import { setCredential } from "../auth/auth"
import { replyPermission } from "../permission/permission"
import { listCommands, runCommand } from "../command/command"
import { createSession, deleteSession, listSessions, updateSession } from "../session/store"
import { cancel, compactSession, NoModelError, prompt, shell } from "../session/prompt"
import { redo, undo } from "../session/revert"
import { exportMarkdown, forkSession } from "../session/export"
import { shareHTML } from "../session/share"
import { totalTokens, type AssistantMessage } from "../session/message"
import { listFiles } from "../util/walk"
import { mcpStatus } from "../mcp"
import { lspStatus } from "../lsp"
import { checkForUpdate } from "../update/update"
import { loadConfig } from "../config/config"
import { isTrusted, trustProject } from "../config/trust"
import { reloadProjectState } from "../config/reload"
import { formatStatus } from "../git/git"
import { snapshotStatus } from "../snapshot/snapshot"
import { app } from "./state"
import { DEFAULT_KEYBINDS } from "./keybinds"
import { getTheme, THEMES } from "./theme"
import { Header, MessageView, Muted, Plain, SPINNER } from "./view"
import { Prompt, type Completion } from "./prompt"
import { Conversation } from "./conversation"
import { InputDialog, PermissionDialog, SelectDialog, TextDialog, type SelectItem } from "./dialog"
import type { Model } from "../provider/types"

type Dialog =
  | { type: "models" }
  | { type: "sessions" }
  | { type: "agents" }
  | { type: "themes" }
  | { type: "providers" }
  | { type: "key"; providerID: string; name: string }
  | { type: "rename" }
  | { type: "text"; title: string; markdown: string }

const BUILTIN_COMMANDS: Completion[] = [
  { label: "/new", value: "/new", description: "start a new session" },
  { label: "/sessions", value: "/sessions", description: "resume, rename or delete a session" },
  { label: "/models", value: "/models", description: "switch model" },
  { label: "/agents", value: "/agents", description: "switch agent" },
  { label: "/connect", value: "/connect", description: "add a provider API key" },
  { label: "/undo", value: "/undo", description: "undo the last message and its file changes" },
  { label: "/redo", value: "/redo", description: "redo what was undone" },
  { label: "/compact", value: "/compact", description: "summarise the conversation to free up context" },
  { label: "/details", value: "/details", description: "toggle full tool output and reasoning" },
  { label: "/export", value: "/export", description: "save the conversation as Markdown" },
  { label: "/share", value: "/share", description: "save a read-only HTML conversation to review and share" },
  { label: "/editor", value: "/editor", description: "write the prompt in $EDITOR" },
  { label: "/fork", value: "/fork", description: "continue in a copy of this session" },
  { label: "/rename", value: "/rename ", description: "rename this session" },
  { label: "/theme", value: "/theme", description: "switch theme" },
  { label: "/mcp", value: "/mcp", description: "MCP and LSP status" },
  { label: "/trust", value: "/trust", description: "let this project's config run commands" },
  { label: "/help", value: "/help", description: "keys and commands" },
  { label: "/exit", value: "/exit", description: "quit" },
]

const HELP = `## Keys

- **enter** send · **\\\\ + enter**, **alt+enter** or **ctrl+j** new line
- **tab** switch agent (build / plan) · **esc esc** interrupt the running turn
- **↑ / ↓** move, or walk prompt history at the first / last line
- **ctrl+a / ctrl+e** line start / end · **ctrl+w** delete word · **ctrl+u / ctrl+k** delete to start / end
- **ctrl+c** clear the prompt, twice to quit · **ctrl+d** quit when empty

## Prompt

- \`@path\` attaches a file or directory (fuzzy completion)
- \`!command\` runs a shell command and shares its output with the agent
- \`/command\` runs a command; custom ones live in \`.vedecaps/command/*.md\`

## Commands

${BUILTIN_COMMANDS.map((c) => `- \`${c.label}\` ${c.description}`).join("\n")}
- \`/init\` create or update AGENTS.md · \`/review\` review changes

Docs: https://github.com/nxodh/vedecaps`

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M"
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k"
  return String(n)
}

function relativeTime(time: number): string {
  const seconds = Math.max(0, (Date.now() - time) / 1000)
  if (seconds < 60) return "just now"
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86_400)}d ago`
}

const historyFile = () => path.join(Paths.state, "prompt-history.json")

export interface AppOptions {
  sessionID?: string
  initialPrompt?: string
  agent?: string
  model?: { providerID: string; modelID: string }
}

export function App(props: { options: AppOptions }) {
  useSyncExternalStore(app.subscribe, app.snapshot)
  const { exit, suspendTerminal } = useApp()
  const { columns, rows } = useWindowSize()
  const width = Math.max(1, columns || 80)
  const height = Math.max(1, rows || 24)
  const theme = getTheme(app.theme)
  const [dialog, setDialog] = useState<Dialog | undefined>()
  const [frame, setFrame] = useState(0)
  const [ready, setReady] = useState(false)
  const [keybinds, setKeybinds] = useState<Record<string, string>>()
  const [history, setHistory] = useState<string[]>([])
  const [agents, setAgents] = useState<string[]>(["build", "plan"])
  const [customCommands, setCustomCommands] = useState<Completion[]>([])
  const [modelInfo, setModelInfo] = useState<Model | undefined>()
  const [items, setItems] = useState<SelectItem<string>[]>([])
  const queue = useRef<string[]>([])
  const [queued, setQueued] = useState(0)
  const promptControl = useRef<{ set(text: string): void; get(): string } | undefined>(undefined)
  const filesCache = useRef<Promise<string[]> | undefined>(undefined)

  const busy = app.status.type !== "idle"

  useEffect(() => {
    app.start()
    void (async () => {
      const state = await readState()
      const config = await getConfig()
      const configured = config.theme
      setKeybinds(config.keybinds)
      const themeName = state.theme ?? configured
      if (themeName && THEMES[themeName]) app.theme = themeName
      const primaries = (await primaryAgents()).map((a) => a.name)
      setAgents(primaries)
      app.agent = props.options.agent ?? (state.agent && primaries.includes(state.agent) ? state.agent : (primaries[0] ?? "build"))
      const { defaultModel } = await import("../provider/provider")
      app.model = props.options.model ?? (await defaultModel())
      app.mcp = mcpStatus()
      const commands = Object.values(await listCommands())
      setCustomCommands(commands.map((c) => ({ label: "/" + c.name, value: "/" + c.name + " ", description: c.description ?? "custom command" })))
      setHistory(await fs.readFile(historyFile(), "utf8").then((t) => JSON.parse(t) as string[], () => []))
      await app.open(props.options.sessionID)
      setReady(true)
      void loadConfig().then((loaded) => {
        if (loaded.blocked.length) {
          app.showToast(`This project's config wants to run commands (${loaded.blocked.length}); ignored until trusted. Review it, then /trust`, "info", 12000)
        }
      })
      void checkForUpdate().then((latest) => latest && app.showToast(`Vedecaps ${latest} is available. Run \`vedecaps upgrade\` to update.`, "info", 8000))
      if (props.options.initialPrompt) submit(props.options.initialPrompt)
    })()
    return () => app.stop()
  }, [])

  useEffect(() => {
    if (!busy) return
    const timer = setInterval(() => setFrame((f) => f + 1), 100)
    return () => clearInterval(timer)
  }, [busy])

  // branch and change count in the status bar: on start, after every turn, and now and then
  // (the user may commit or switch branches in another terminal)
  useEffect(() => {
    if (!ready) return
    app.refreshGit(0)
    if (busy) return
    app.refreshGit(300)
    const timer = setInterval(() => app.refreshGit(0), 20_000)
    return () => clearInterval(timer)
  }, [ready, busy])

  useEffect(() => {
    let cancelled = false
    if (!app.model) return setModelInfo(undefined)
    getModel(app.model.providerID, app.model.modelID).then(
      (m) => !cancelled && setModelInfo(m.model),
      () => !cancelled && setModelInfo(undefined),
    )
    return () => {
      cancelled = true
    }
  }, [app.model?.providerID, app.model?.modelID])

  // Send queued prompts once the current turn finishes.
  useEffect(() => {
    if (busy || queue.current.length === 0) return
    const next = queue.current.shift()!
    setQueued(queue.current.length)
    submit(next)
  }, [busy])

  const fail = (err: unknown) => app.showToast(err instanceof Error ? err.message : String(err), "error", 6000)

  const remember = (text: string) => {
    setHistory((current) => {
      const next = [...current.filter((h) => h !== text), text].slice(-200)
      void fs.mkdir(Paths.state, { recursive: true }).then(() => fs.writeFile(historyFile(), JSON.stringify(next))).catch(() => {})
      return next
    })
  }

  const ensureSession = async (): Promise<string> => {
    if (app.session) return app.session.id
    const session = await createSession()
    // Adopt it without redrawing: the home header stays as the top of the new conversation.
    app.session = session
    app.messages = []
    return session.id
  }

  const send = async (text: string) => {
    try {
      const sessionID = await ensureSession()
      await prompt({ sessionID, text, agent: app.agent, model: app.model })
    } catch (err) {
      if (err instanceof NoModelError || (err instanceof Error && err.name === "ModelNotFoundError")) {
        app.showToast(err.message, "error", 8000)
        void openProviders()
      } else fail(err)
    }
  }

  const openProviders = async () => {
    const providers = await allProviders()
    const popular = ["anthropic", "openai", "google", "openrouter", "xai", "groq", "deepseek", "mistral"]
    const ids = [...popular.filter((p) => providers[p]), ...Object.keys(providers).filter((p) => !popular.includes(p)).sort()]
    setItems(
      ids.map((id) => ({
        value: id,
        label: providers[id]!.name,
        hint: providers[id]!.source === "none" ? id : `${id} · connected (${providers[id]!.source})`,
        group: popular.includes(id) ? "Popular" : "Other",
      })),
    )
    setDialog({ type: "providers" })
  }

  const openModels = async () => {
    const providers = await availableProviders()
    if (providers.length === 0) {
      app.showToast("No provider is connected yet. Add an API key first.", "info")
      return openProviders()
    }
    const state = await readState()
    const recent = (state.recentModels ?? []).filter((ref) => providers.some((p) => ref.startsWith(p.id + "/") && p.models[ref.slice(p.id.length + 1)]))
    const list: SelectItem<string>[] = recent.map((ref) => {
      const [providerID, ...rest] = ref.split("/")
      const provider = providers.find((p) => p.id === providerID)!
      const model = provider.models[rest.join("/")]!
      return { value: ref, label: model.name, hint: provider.name, group: "Recent" }
    })
    for (const provider of providers) {
      const models = Object.values(provider.models).sort((a, b) => (b.releaseDate ?? "").localeCompare(a.releaseDate ?? "") || a.name.localeCompare(b.name))
      for (const model of models) {
        list.push({
          value: `${provider.id}/${model.id}`,
          label: model.name,
          hint: `${formatTokens(model.limit.context)} ctx${model.cost.input ? ` · $${model.cost.input}/$${model.cost.output}` : ""}`,
          group: provider.name,
        })
      }
    }
    setItems(list)
    setDialog({ type: "models" })
  }

  const openSessions = async () => {
    const sessions = await listSessions()
    setItems(sessions.map((s) => ({ value: s.id, label: s.title, hint: relativeTime(s.time.updated) })))
    setDialog({ type: "sessions" })
  }

  const openAgents = async () => {
    const all = Object.values(await listAgents()).filter((a) => a.mode !== "subagent" && !a.hidden)
    setItems(all.map((a) => ({ value: a.name, label: a.name, hint: a.description })))
    setDialog({ type: "agents" })
  }

  const status = async () => {
    const mcp = mcpStatus()
    const lsp = await lspStatus().catch(() => [])
    const lines = ["## MCP servers", ""]
    if (mcp.length === 0) lines.push("None configured. Add servers under `mcp` in vedecaps.json or with `vedecaps mcp add`.")
    for (const server of mcp) lines.push(`- **${server.name}** ${server.status}${server.status === "connected" ? ` · ${server.tools} tools` : ""}${server.error ? ` · ${server.error}` : ""}`)
    lines.push("", "## Language servers", "")
    if (lsp.length === 0) lines.push("None running yet. They start when a matching file is edited.")
    for (const server of lsp) lines.push(`- **${server.id}** ${server.connected ? "connected" : "stopped"} · ${server.root}`)
    setDialog({ type: "text", title: "Status", markdown: lines.join("\n") })
  }

  const editInEditor = async () => {
    const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === "win32" ? "notepad" : "vi")
    const file = path.join(os.tmpdir(), `vedecaps-prompt-${Date.now()}.md`)
    await fs.writeFile(file, promptControl.current?.get() ?? "")
    try {
      await suspendTerminal(
        () =>
          new Promise<void>((resolve) => {
            const child = spawn(editor, [file], { stdio: "inherit", shell: true })
            child.on("exit", () => resolve())
            child.on("error", () => resolve())
          }),
      )
      const text = (await fs.readFile(file, "utf8")).replace(/\s+$/, "")
      promptControl.current?.set(text)
    } catch (err) {
      fail(err)
    } finally {
      await fs.rm(file, { force: true })
    }
  }

  const slash = async (name: string, args: string): Promise<void> => {
    switch (name) {
      case "new":
      case "clear":
        return app.open(undefined)
      case "sessions":
      case "resume":
        return openSessions()
      case "models":
      case "model":
        return openModels()
      case "agents":
      case "agent":
        return openAgents()
      case "connect":
      case "login":
        return openProviders()
      case "theme":
      case "themes":
        setItems(Object.values(THEMES).map((t) => ({ value: t.name, label: t.name, hint: t.description })))
        return setDialog({ type: "themes" })
      case "help":
        return setDialog({ type: "text", title: `Vedecaps ${VERSION}`, markdown: HELP.replace(/## Keys[\s\S]*?## Prompt/, `## Keys\n\n${Object.entries(DEFAULT_KEYBINDS).map(([action, binding]) => `- **${keybinds?.[action] ?? binding}** ${action}`).join("\n")}\n\n## Prompt`) })
      case "mcp":
      case "status":
        return status()
      case "trust": {
        const root = project().worktree
        if (await isTrusted(root)) return app.showToast("This project is already trusted.")
        if (args.trim().toLowerCase() === "yes") {
          await trustProject(root)
          await reloadProjectState()
          setKeybinds((await getConfig()).keybinds)
          setAgents((await primaryAgents()).map((a) => a.name))
          setCustomCommands(Object.values(await listCommands()).map((c) => ({ label: "/" + c.name, value: "/" + c.name + " ", description: c.description ?? "custom command" })))
          app.epoch++
          return app.showToast("Trusted. The project's config is active now.")
        }
        const loaded = await loadConfig()
        if (!loaded.blocked.length) {
          await trustProject(root)
          return app.showToast("Trusted. Nothing in this project's config needed it.")
        }
        setDialog({
          type: "text",
          title: "Trust this project?",
          markdown: `## ${root}\n\nIts config asks for:\n\n${loaded.blocked.map((b) => `- ${b}`).join("\n")}\n\nOnly trust a project whose config files you have read. Trusting lets them start programs and choose where requests are sent. Type \`/trust yes\` to confirm.`,
        })
        return
      }
      case "details":
        app.details = !app.details
        app.epoch++
        app.showToast(app.details ? "Showing full tool output" : "Showing compact tool output")
        return
      case "editor":
        return editInEditor()
      case "exit":
      case "quit":
      case "q":
        return exit()
    }
    if (!app.session) {
      if (["undo", "redo", "compact", "export", "share", "fork", "rename"].includes(name)) return app.showToast("There is no conversation yet.")
    }
    const sessionID = app.session?.id
    switch (name) {
      case "share": {
        const target = path.resolve(project().directory, args.trim() || `vedecaps-${sessionID!.slice(-8)}.html`)
        await fs.writeFile(target, await shareHTML(sessionID!), { mode: 0o600 })
        return app.showToast(`Saved ${target}. Review private content before sharing.`, "info", 9000)
      }
      case "undo": {
        const result = await undo(sessionID!)
        const text = result.message.parts.find((p) => p.type === "text" && !p.synthetic)
        if (text?.type === "text") promptControl.current?.set(text.text)
        const snapshot = await snapshotStatus()
        app.refreshGit(0)
        if (!snapshot.available) {
          // be explicit: the conversation was rewound but nothing on disk changed
          return app.showToast(`Undone in the conversation only. Files were not restored: ${snapshot.reason}.`, "error", 9000)
        }
        const n = result.files.length
        return app.showToast(`Undone${n ? ` · ${n} file${n === 1 ? "" : "s"} restored` : " · no file changes to restore"}. /redo to bring it back.`)
      }
      case "redo": {
        const result = await redo(sessionID!)
        return app.showToast(result.done ? "Everything is back." : "Redone one step.")
      }
      case "compact":
      case "summarize":
        await compactSession(sessionID!)
        return
      case "export": {
        const target = path.resolve(project().directory, args.trim() || `vedecaps-${sessionID!.slice(-8)}.md`)
        await fs.writeFile(target, await exportMarkdown(sessionID!, { tools: true }))
        return app.showToast(`Exported to ${target}`)
      }
      case "fork": {
        const copy = await forkSession(sessionID!)
        await app.open(copy.id)
        return app.showToast("Now in a copy of the session.")
      }
      case "rename":
        if (args.trim()) {
          await updateSession(sessionID!, (s) => (s.title = args.trim()))
          return app.showToast("Renamed.")
        }
        return setDialog({ type: "rename" })
    }
    const commands = await listCommands()
    if (!commands[name]) return app.showToast(`Unknown command: /${name}. Try /help.`, "error")
    const id = await ensureSession()
    await runCommand({ sessionID: id, name, arguments: args, agent: app.agent, model: app.model })
  }

  function submit(text: string) {
    remember(text)
    if (text.startsWith("/") && !text.startsWith("//")) {
      const space = text.indexOf(" ")
      const name = (space === -1 ? text.slice(1) : text.slice(1, space)).toLowerCase()
      void slash(name, space === -1 ? "" : text.slice(space + 1)).catch(fail)
      return
    }
    if (busy || queue.current.length > 0) {
      if (busy) {
        queue.current.push(text)
        setQueued(queue.current.length)
        return
      }
    }
    if (text.startsWith("!") && text.length > 1) {
      void ensureSession()
        .then((sessionID) => shell({ sessionID, command: text.slice(1).trim(), agent: app.agent }))
        .catch(fail)
      return
    }
    void send(text)
  }

  const cycleAgent = () => {
    if (agents.length < 2) return
    app.agent = agents[(agents.indexOf(app.agent) + 1) % agents.length]!
    void writeState({ agent: app.agent }).catch(() => {})
    app.notify(true)
  }

  // Keep completed and live messages separate so only streaming messages receive animation frames.
  const { settled, live } = useMemo(() => {
    let split = app.messages.length
    for (let i = 0; i < app.messages.length; i++) {
      const m = app.messages[i]!
      if (m.role === "assistant" && !m.time.completed) {
        split = i
        break
      }
    }
    return { settled: app.messages.slice(0, split), live: app.messages.slice(split) }
  }, [app.version, app.epoch])

  const usage = useMemo(() => {
    let cost = 0
    let last: AssistantMessage | undefined
    for (const m of app.messages) {
      if (m.role !== "assistant") continue
      cost += m.cost
      if (m.time.completed && totalTokens(m.tokens) > 0) last = m
    }
    const tokens = last ? totalTokens(last.tokens) : 0
    const percent = modelInfo?.limit.context ? Math.round((tokens / modelInfo.limit.context) * 100) : undefined
    return { cost, tokens, percent }
  }, [app.version, modelInfo])

  const footer = useRef(null)
  const footerMetrics = useBoxMetrics(footer)
  const wrapper = useRef(null)
  const metrics = useBoxMetrics(wrapper)
  const permission = app.permissions[0]
  const activeTodo = app.todos.find((t) => t.status === "in_progress")
  const remaining = app.todos.filter((t) => t.status === "pending" || t.status === "in_progress").length

  const elapsed = app.status.type !== "idle" ? Math.floor((Date.now() - app.status.since) / 1000) : 0
  const dialogRows = Math.max(1, Math.min(14, Math.floor((height - 8) / 2)))

  let bottom: React.ReactNode
  if (permission) {
    bottom = <PermissionDialog key={permission.id} theme={theme} width={width} request={permission} queued={app.permissions.length - 1} maxDetailRows={Math.max(0, height - 13)} onReply={(reply) => replyPermission(permission.id, reply)} />
  } else if (dialog?.type === "models") {
    bottom = (
      <SelectDialog
        theme={theme}
        width={width}
        rows={dialogRows}
        title="Select a model"
        items={items}
        current={app.model ? `${app.model.providerID}/${app.model.modelID}` : undefined}
        onCancel={() => setDialog(undefined)}
        onSelect={(ref) => {
          const slashAt = ref.indexOf("/")
          app.model = { providerID: ref.slice(0, slashAt), modelID: ref.slice(slashAt + 1) }
          void readState().then((s) => writeState({ model: app.model, recentModels: [ref, ...(s.recentModels ?? []).filter((r) => r !== ref)].slice(0, 5) }))
          setDialog(undefined)
          app.notify(true)
        }}
      />
    )
  } else if (dialog?.type === "sessions") {
    bottom = (
      <SelectDialog
        theme={theme}
        width={width}
        rows={dialogRows}
        title="Sessions"
        items={items}
        current={app.session?.id}
        empty="No saved sessions in this project yet"
        onCancel={() => setDialog(undefined)}
        onSelect={(id) => {
          setDialog(undefined)
          void app.open(id).catch(fail)
        }}
        action={{
          key: "x",
          label: "delete",
          run: (id) => {
            void deleteSession(id)
              .then(async () => {
                if (app.session?.id === id) await app.open(undefined)
                setItems((current) => current.filter((i) => i.value !== id))
              })
              .catch(fail)
          },
        }}
      />
    )
  } else if (dialog?.type === "agents") {
    bottom = (
      <SelectDialog
        theme={theme}
        width={width}
        rows={dialogRows}
        title="Select an agent"
        items={items}
        current={app.agent}
        onCancel={() => setDialog(undefined)}
        onSelect={(name) => {
          app.agent = name
          void writeState({ agent: name }).catch(() => {})
          setDialog(undefined)
          app.notify(true)
        }}
      />
    )
  } else if (dialog?.type === "themes") {
    bottom = (
      <SelectDialog
        theme={theme}
        width={width}
        title="Theme"
        items={items}
        current={app.theme}
        onCancel={() => setDialog(undefined)}
        onSelect={(name) => {
          app.theme = name
          void writeState({ theme: name }).catch(() => {})
          setDialog(undefined)
          app.epoch++
          app.notify(true)
        }}
      />
    )
  } else if (dialog?.type === "providers") {
    bottom = (
      <SelectDialog
        theme={theme}
        width={width}
        rows={dialogRows}
        title="Connect a provider"
        items={items}
        onCancel={() => setDialog(undefined)}
        onSelect={(id) => setDialog({ type: "key", providerID: id, name: items.find((i) => i.value === id)?.label ?? id })}
      />
    )
  } else if (dialog?.type === "key") {
    const { providerID, name } = dialog
    bottom = (
      <InputDialog
        theme={theme}
        width={width}
        title={`Connect ${name}`}
        label="Paste the API key. It is stored on this machine only, readable by your user."
        mask
        onCancel={() => setDialog(undefined)}
        onSubmit={(key) => {
          setDialog(undefined)
          if (!key) return
          void setCredential(providerID, { type: "api", key })
            .then(async () => {
              resetProviders()
              app.showToast(`${name} connected.`)
              await openModels()
            })
            .catch(fail)
        }}
      />
    )
  } else if (dialog?.type === "rename") {
    bottom = (
      <InputDialog
        theme={theme}
        width={width}
        title="Rename session"
        label="New title"
        initial={app.session?.title}
        onCancel={() => setDialog(undefined)}
        onSubmit={(title) => {
          setDialog(undefined)
          if (title && app.session) void updateSession(app.session.id, (s) => (s.title = title)).catch(fail)
        }}
      />
    )
  } else if (dialog?.type === "text") {
    bottom = <TextDialog theme={theme} width={width} height={Math.max(1, height - 7)} title={dialog.title} markdown={dialog.markdown} onClose={() => setDialog(undefined)} />
  }

  const modelLabel = modelInfo?.name ?? app.model?.modelID ?? "no model · /connect"
  const right = [
    usage.percent !== undefined && usage.tokens > 0 ? `${formatTokens(usage.tokens)} · ${usage.percent}%` : undefined,
    usage.cost > 0 ? `$${usage.cost.toFixed(usage.cost < 1 ? 3 : 2)}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ")
  const settledViews = useMemo(() => settled.map((message) => (
    <MessageView key={message.id} message={message} theme={theme} width={width} details={app.details} />
  )), [settled, theme, width, app.details])

  if (!ready) return <Box width={width} height={height}><Muted theme={theme}>Loading…</Muted></Box>

  return (
    <Box width={width} height={height} flexDirection="column" overflow="hidden">
      <Box height={1} flexShrink={0} paddingX={1} justifyContent="space-between">
        <Box flexShrink={0} marginRight={2}><Plain theme={theme} bold>{`VEDECAPS · v${VERSION}`}</Plain></Box>
        <Box flexGrow={1} flexShrink={1} minWidth={0} justifyContent="flex-end"><Muted theme={theme} wrap="truncate-end">{project().directory}</Muted></Box>
      </Box>
      <Conversation key={app.epoch} width={width} theme={theme} active={!bottom} keybinds={keybinds} followID={app.messages.findLast((m) => m.role === "user")?.id}>
        <Header theme={theme} directory={project().directory} width={width} />
        {settledViews}
        {live.map((message) => (
          <MessageView key={message.id} message={message} theme={theme} width={width} details={app.details} frame={frame} live />
        ))}
      </Conversation>
      <Box ref={footer} flexShrink={0} flexDirection="column">
        {busy && !bottom ? (
          <Box marginTop={1} marginLeft={1}>
            <Text wrap="truncate-end">
              <Plain theme={theme} bold>{SPINNER[frame % SPINNER.length]! + " "}</Plain>
              {app.status.type === "retry" ? (
                <Plain theme={theme}>{`Retrying in ${Math.max(0, Math.ceil((app.status.next - Date.now()) / 1000))}s (attempt ${app.status.attempt}) · ${app.status.message}`}</Plain>
              ) : (
                <Plain theme={theme}>{activeTodo ? activeTodo.content : "Working"}</Plain>
              )}
              <Muted theme={theme}>{`  ${elapsed}s${remaining > 1 ? ` · ${remaining} steps left` : ""}${queued ? ` · ${queued} queued` : ""}`}</Muted>
            </Text>
          </Box>
        ) : null}
        {app.toast && !bottom ? (
          <Box marginTop={1} marginLeft={1}>
            <Text wrap="truncate-end">
              {app.toast.kind === "error" ? <Plain theme={theme} inverse bold>{" ERROR "}</Plain> : <Plain theme={theme} bold>{"◆"}</Plain>}
              <Plain theme={theme}>{" " + app.toast.text}</Plain>
            </Text>
          </Box>
        ) : null}
        <Box ref={wrapper} marginTop={1} flexDirection="column">
          {bottom ?? null}
          <Box display={bottom ? "none" : "flex"} flexDirection="column">
            <Prompt
              keybinds={keybinds}
              theme={theme}
              width={width}
              offsetTop={(footerMetrics.hasMeasured ? footerMetrics.top : 0) + (metrics.hasMeasured ? metrics.top : 0)}
              maxHeight={Math.max(4, height - 5 - (busy ? 2 : 0) - (app.toast ? 2 : 0))}
              agent={app.agent}
              active={!bottom}
              busy={busy}
              history={history}
              commands={[...BUILTIN_COMMANDS, ...customCommands.filter((c) => !BUILTIN_COMMANDS.some((b) => b.label === c.label))]}
              files={() => (filesCache.current ??= listFiles({ cwd: project().directory, limit: 20_000 }).catch(() => []))}
              onSubmit={submit}
              onCommand={(name) => submit("/" + name)}
              onCycleAgent={cycleAgent}
              onInterrupt={() => {
                if (app.session && cancel(app.session.id)) {
                  queue.current = []
                  setQueued(0)
                }
              }}
              onExit={() => exit()}
              control={promptControl}
            />
          </Box>
        </Box>
        <Box height={1} flexShrink={0} paddingX={1} justifyContent="space-between" width={width}>
          <Box flexGrow={1} flexShrink={1} minWidth={0}><Muted theme={theme} wrap="truncate-end">{`${modelLabel}${app.session ? " · " + app.session.title : ""}${app.git ? "  ⎇ " + formatStatus(app.git) : ""}`}</Muted></Box>
          <Box flexShrink={0} marginLeft={2}><Muted theme={theme}>{right}</Muted></Box>
        </Box>
      </Box>
    </Box>
  )
}
