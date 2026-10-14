"use strict"
const vscode = require("vscode")
const path = require("node:path")
const { DeberopaClient } = require("./lib/client")
const { createState, applyEvent } = require("./lib/store")
const { resolveCommand, startServer } = require("./lib/server")

/** @type {ChatController | undefined} */
let controller

class ChatController {
  constructor(context) {
    this.context = context
    this.state = createState()
    this.view = undefined
    this.server = undefined
    this.client = undefined
    this.starting = undefined
    this.streamAbort = undefined
    this.pendingInsert = []
    this.choices = { agents: [], models: [], defaultModel: undefined }
    this.local = { servers: [], failures: [], expected: [] }
    this.slots = null
    this.toolcheck = null
    this.slotTimer = undefined
    this.sessions = []
    this.trustInfo = null
    this.commandList = []
    this.connectable = []
    this.selection = context.globalState.get("deberopa.selection", {})
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
    this.status.command = "deberopa.focus"
    context.subscriptions.push(this.status)
  }

  folder() {
    return vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]
  }

  setStatus(text, tooltip) {
    this.status.text = `$(hubot) ${text}`
    this.status.tooltip = tooltip
    this.status.show()
  }

  push() {
    if (this.view) this.view.webview.postMessage({ type: "state", state: this.state, choices: this.choices, selection: this.selection, local: this.local, slots: this.slots, toolcheck: this.toolcheck, sessions: this.sessions, trust: this.trustInfo, connectable: this.connectable })
  }

  async loadSessions() {
    try {
      const list = await this.client.sessions()
      this.sessions = list.slice().sort((a, b) => b.time.updated - a.time.updated).slice(0, 50).map((s) => ({ id: s.id, title: s.title, updated: s.time.updated }))
    } catch {
      this.sessions = []
    }
  }

  async loadTrust() {
    try {
      this.trustInfo = await this.client.trust()
    } catch {
      this.trustInfo = null
    }
  }

  /** Providers that do not have a key yet and can take one, the usual hosted ones first. */
  async loadConnectable() {
    try {
      const popular = ["anthropic", "openai", "google", "openrouter", "groq", "deepseek", "mistral", "xai"]
      const { providers } = await this.client.providers()
      const open = providers.filter((p) => !p.connected && !p.local)
      this.connectable = [...open.filter((p) => popular.includes(p.id)).sort((a, b) => popular.indexOf(a.id) - popular.indexOf(b.id)), ...open.filter((p) => !popular.includes(p.id)).sort((a, b) => a.name.localeCompare(b.name))]
        .slice(0, 30)
        .map((p) => ({ id: p.id, name: p.name }))
    } catch {
      this.connectable = []
    }
  }

  async loadLocal() {
    try {
      this.local = await this.client.local()
    } catch {
      this.local = { servers: [], failures: [] }
    }
  }

  async loadChoices() {
    const [agents, providers] = await Promise.all([this.client.agents(), this.client.providers()])
    this.choices = {
      agents: agents.filter((a) => a.mode !== "subagent" && !a.hidden).map((a) => ({ name: a.name, description: a.description || "" })),
      // Local model servers come first: running models on your own machine is what this app is for.
      models: providers.providers
        .filter((p) => p.connected)
        .sort((a, b) => Number(!!b.local) - Number(!!a.local))
        .flatMap((p) =>
          Object.values(p.models).map((m) => ({
            value: p.id + "/" + m.id,
            label: (p.local ? "● " : "") + p.name + " · " + m.name,
            local: !!p.local,
            provider: p.id,
            protocol: p.protocol,
            context: m.limit && m.limit.context ? m.limit.context : 0,
            mode: m.mode || null,
          })),
        ),
      defaultModel: providers.default ? providers.default.providerID + "/" + providers.default.modelID : undefined,
    }
  }

  notice(text) {
    if (this.view) this.view.webview.postMessage({ type: "notice", text })
  }

  async ensureServer() {
    if (this.client) return this.client
    if (this.starting) return this.starting
    this.starting = (async () => {
      const folder = this.folder()
      if (!folder) throw new Error("Open a folder first: the agent works inside a project folder.")
      if (!vscode.workspace.isTrusted) throw new Error("This folder is not trusted. Trust it to start the agent.")
      const cfg = vscode.workspace.getConfiguration("deberopa")
      const command = resolveCommand({ configured: cfg.get("command"), appRoot: vscode.env.appRoot })
      this.setStatus("Deberopa: starting…", command)
      const server = await startServer({ command, args: cfg.get("arguments") || [], directory: folder.uri.fsPath })
      this.server = server
      this.client = new DeberopaClient({ baseUrl: server.baseUrl, password: server.password })
      server.exited.then(() => {
        if (this.server === server) {
          this.server = undefined
          this.client = undefined
          this.stopStream()
          this.setStatus("Deberopa: stopped", "The agent server exited. Run “Deberopa: Restart Agent Server”.")
          this.notice("The agent server stopped.")
        }
      })
      const health = await this.client.health()
      this.setStatus(`Deberopa ${health.version}`, `Agent server at ${server.baseUrl}`)
      this.startStream()
      await this.loadChoices().catch(() => {})
      await this.loadLocal()
      await Promise.all([this.loadSessions(), this.loadTrust(), this.loadConnectable()])
      this.client.commands().then((c) => { this.commandList = c.map((x) => ({ name: x.name, description: x.description || "" })) }).catch(() => {})
      return this.client
    })()
    try {
      return await this.starting
    } finally {
      this.starting = undefined
    }
  }

  /** While a turn runs against a local server, watch how many of its slots are busy. */
  watchSlots() {
    const selected = this.selection.model || this.choices.defaultModel
    const entry = this.choices.models.find((m) => m.value === selected)
    const wanted = this.state.busy && entry && entry.local && entry.protocol === "openai"
    if (!wanted) {
      if (this.slotTimer) clearInterval(this.slotTimer)
      this.slotTimer = undefined
      if (this.slots) {
        this.slots = null
        this.push()
      }
      return
    }
    if (this.slotTimer) return
    const poll = async () => {
      try {
        const result = await this.client.slots(entry.provider)
        this.slots = result.slots
      } catch {
        this.slots = null
      }
      this.push()
    }
    poll()
    this.slotTimer = setInterval(poll, 3000)
  }

  startStream() {
    this.stopStream()
    const abort = new AbortController()
    this.streamAbort = abort
    const client = this.client
    const loop = async () => {
      while (!abort.signal.aborted && this.client === client) {
        try {
          await client.events((event) => this.onEvent(event), abort.signal)
        } catch {
          if (abort.signal.aborted) return
        }
        await new Promise((r) => setTimeout(r, 1000))
      }
    }
    loop()
  }

  stopStream() {
    if (this.streamAbort) this.streamAbort.abort()
    this.streamAbort = undefined
  }

  async onEvent(event) {
    if (applyEvent(this.state, event) === "reload") await this.loadMessages()
    this.watchSlots()
    if (event.type === "session.created" || event.type === "session.deleted" || event.type === "session.updated") this.loadSessions().then(() => this.push())
    // a finished download changes which models exist
    if (event.type === "local.pull" && event.properties && event.properties.done && !event.properties.error) {
      await this.loadChoices().catch(() => {})
      await this.loadLocal()
    }
    this.push()
  }

  async loadMessages() {
    if (!this.client || !this.state.sessionID) return
    this.state.messages = await this.client.messages(this.state.sessionID)
  }

  async ensureSession() {
    const client = await this.ensureServer()
    if (this.state.sessionID) return client
    const sessions = await client.sessions()
    const latest = sessions.slice().sort((a, b) => b.time.updated - a.time.updated)[0]
    const session = latest || (await client.createSession())
    this.state.sessionID = session.id
    this.state.title = session.title
    await this.loadMessages()
    this.state.permissions = await client.permissions()
    return client
  }

  async newSession() {
    const client = await this.ensureServer()
    const session = await client.createSession()
    this.state = { ...createState(), sessionID: session.id, title: session.title }
    this.push()
  }

  async send(text) {
    try {
      const client = await this.ensureSession()
      this.state.error = undefined
      this.state.busy = true
      this.push()
      const chosen = {}
      if (this.selection.agent && this.choices.agents.some((a) => a.name === this.selection.agent)) chosen.agent = this.selection.agent
      if (this.selection.model && this.choices.models.some((m) => m.value === this.selection.model)) chosen.model = this.selection.model
      const slash = /^\/(\S+)\s*([\s\S]*)$/.exec(text)
      if (slash && this.commandList.some((c) => c.name === slash[1])) {
        // custom commands run through their own route (they are not prompts)
        client.runCommand(this.state.sessionID, slash[1], slash[2], chosen).catch((err) => {
          this.state.busy = false
          this.state.error = { name: "Error", message: err.message }
          this.push()
        })
      } else if (text.startsWith("!") && text.slice(1).trim() !== "") {
        client.shell(this.state.sessionID, text.slice(1).trim()).catch((err) => {
          this.state.error = { name: "Error", message: err.message }
          this.push()
        })
      } else await client.prompt(this.state.sessionID, text, chosen)
    } catch (err) {
      this.state.busy = false
      this.state.error = { name: "Error", message: err.message }
      this.push()
    }
  }

  async abort() {
    if (this.client && this.state.sessionID) await this.client.abort(this.state.sessionID).catch(() => {})
  }

  async restart() {
    this.stopStream()
    if (this.server) this.server.stop()
    this.server = undefined
    this.client = undefined
    this.state = createState()
    try {
      await this.ensureSession()
    } catch (err) {
      this.state.error = { name: "Error", message: err.message }
    }
    this.push()
  }

  /** Text for the prompt box from the editor: `@path#L10-20` for a selection, `@path` for a file. */
  referenceFor(uri, range) {
    const folder = vscode.workspace.getWorkspaceFolder(uri)
    const rel = folder ? path.relative(folder.uri.fsPath, uri.fsPath) : uri.fsPath
    const posix = rel.split(path.sep).join("/")
    if (!range || range.isEmpty) return `@${posix}`
    const start = range.start.line + 1
    const end = range.end.character === 0 && range.end.line > range.start.line ? range.end.line : range.end.line + 1
    return start === end ? `@${posix}#L${start}` : `@${posix}#L${start}-${end}`
  }

  insert(text) {
    if (this.view) this.view.webview.postMessage({ type: "insert", text })
    else this.pendingInsert.push(text)
  }

  async handle(message) {
    switch (message.type) {
      case "ready":
        this.push()
        for (const text of this.pendingInsert.splice(0)) this.insert(text)
        try {
          await this.ensureSession()
        } catch (err) {
          this.state.error = { name: "Error", message: err.message }
        }
        this.push()
        return
      case "send":
        return this.send(message.text)
      case "abort":
        return this.abort()
      case "toolcheck": {
        if (!this.client || typeof message.model !== "string") return
        this.toolcheck = { model: message.model, running: true }
        this.push()
        try {
          const result = await this.client.toolcheck(message.model)
          this.toolcheck = { model: message.model, result }
        } catch (err) {
          this.toolcheck = { model: message.model, result: { status: "error", detail: err.message } }
        }
        this.push()
        return
      }
      case "pull": {
        if (!this.client || typeof message.model !== "string") return
        await this.client.pull(message.provider || "ollama", message.model.trim()).catch((e) => this.notice(e.message))
        return
      }
      case "switchSession": {
        if (!this.client || typeof message.id !== "string") return
        try {
          const session = await this.client.session(message.id)
          this.state = { ...createState(), sessionID: session.id, title: session.title, busy: !!session.busy }
          await this.loadMessages()
          this.state.permissions = await this.client.permissions()
        } catch (err) {
          this.notice(err.message)
        }
        this.push()
        return
      }
      case "deleteSession": {
        if (!this.client || typeof message.id !== "string") return
        await this.client.deleteSession(message.id).catch((e) => this.notice(e.message))
        if (message.id === this.state.sessionID) this.state = createState()
        await this.loadSessions()
        this.push()
        return
      }
      case "grantTrust": {
        if (!this.client) return
        await this.client.grantTrust().catch((e) => this.notice(e.message))
        await this.loadTrust()
        await this.loadChoices().catch(() => {})
        this.push()
        return
      }
      case "connect": {
        if (!this.client || typeof message.provider !== "string" || typeof message.key !== "string") return
        try {
          await this.client.setKey(message.provider, message.key)
          await this.loadChoices()
          await this.loadConnectable()
          this.notice("Saved. The provider's models are in the model list now.")
        } catch (err) {
          this.notice(err.message)
        }
        this.push()
        return
      }
      case "suggest": {
        if (!this.client || !this.view) return
        const query = typeof message.query === "string" ? message.query : ""
        let items = []
        try {
          if (message.kind === "file") items = (await this.client.findFile(query, 8)).map((f) => ({ value: "@" + f, label: f }))
          else if (message.kind === "command") {
            const q = query.toLowerCase()
            items = this.commandList.filter((c) => c.name.toLowerCase().startsWith(q)).slice(0, 8).map((c) => ({ value: "/" + c.name + " ", label: "/" + c.name, hint: c.description }))
          }
        } catch {
          items = []
        }
        this.view.webview.postMessage({ type: "suggestions", kind: message.kind, seq: message.seq, items })
        return
      }
      case "rescanLocal":
        await this.loadLocal()
        await this.loadChoices().catch(() => {})
        this.push()
        return
      case "select":
        if (message.key === "agent" || message.key === "model") {
          this.selection = { ...this.selection, [message.key]: message.value || undefined }
          await this.context.globalState.update("deberopa.selection", this.selection)
          this.push()
        }
        return
      case "newSession":
        return this.newSession().catch((e) => this.notice(e.message))
      case "permission":
        if (this.client) await this.client.replyPermission(message.id, message.reply).catch((e) => this.notice(e.message))
        return
      case "revert":
        if (this.client) await this.client.revert(this.state.sessionID, message.messageID).catch((e) => this.notice(e.message))
        return
      case "unrevert":
        if (this.client) await this.client.unrevert(this.state.sessionID).catch((e) => this.notice(e.message))
        return
      case "compact":
        if (this.client) await this.client.compact(this.state.sessionID).catch((e) => this.notice(e.message))
        return
      case "open": {
        const folder = this.folder()
        if (!folder || typeof message.path !== "string") return
        const target = path.resolve(folder.uri.fsPath, message.path)
        if (path.relative(folder.uri.fsPath, target).startsWith("..")) return
        await vscode.window.showTextDocument(vscode.Uri.file(target), { preview: true }).then(undefined, () => {})
        return
      }
    }
  }

  dispose() {
    if (this.slotTimer) clearInterval(this.slotTimer)
    this.stopStream()
    if (this.server) this.server.stop()
  }
}

class ChatViewProvider {
  constructor(chat, context) {
    this.chat = chat
    this.context = context
  }

  resolveWebviewView(view) {
    const media = vscode.Uri.joinPath(this.context.extensionUri, "media")
    view.webview.options = { enableScripts: true, localResourceRoots: [media] }
    this.chat.view = view
    const nonce = require("node:crypto").randomBytes(16).toString("base64")
    const css = view.webview.asWebviewUri(vscode.Uri.joinPath(media, "chat.css"))
    const js = view.webview.asWebviewUri(vscode.Uri.joinPath(media, "chat.js"))
    view.webview.html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${css}"></head>
<body><div id="app"></div><script nonce="${nonce}" src="${js}"></script></body></html>`
    view.webview.onDidReceiveMessage((m) => this.chat.handle(m))
    view.onDidDispose(() => { if (this.chat.view === view) this.chat.view = undefined })
  }
}

function activate(context) {
  controller = new ChatController(context)
  const provider = new ChatViewProvider(controller, context)
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("deberopa.chat", provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand("deberopa.focus", () => vscode.commands.executeCommand("deberopa.chat.focus")),
    vscode.commands.registerCommand("deberopa.newSession", () => controller.newSession()),
    vscode.commands.registerCommand("deberopa.abort", () => controller.abort()),
    vscode.commands.registerCommand("deberopa.restartServer", () => controller.restart()),
    vscode.commands.registerCommand("deberopa.addSelection", async () => {
      const editor = vscode.window.activeTextEditor
      if (!editor) return
      controller.insert(controller.referenceFor(editor.document.uri, editor.selection) + " ")
      await vscode.commands.executeCommand("deberopa.chat.focus")
    }),
    vscode.commands.registerCommand("deberopa.addFile", async (uri) => {
      const target = uri || (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri)
      if (!target) return
      controller.insert(controller.referenceFor(target) + " ")
      await vscode.commands.executeCommand("deberopa.chat.focus")
    }),
    { dispose: () => controller && controller.dispose() },
  )
  // A small read-only surface for the in-app end-to-end test (desktop/test/e2e).
  return {
    ensureSession: () => controller.ensureSession().then(() => undefined),
    status: () => ({
      running: !!controller.client,
      sessionID: controller.state.sessionID,
      models: controller.choices.models.length,
      agents: controller.choices.agents.length,
    }),
  }
}

function deactivate() {
  if (controller) controller.dispose()
}

module.exports = { activate, deactivate }
