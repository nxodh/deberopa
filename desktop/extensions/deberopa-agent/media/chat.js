/* global acquireVsCodeApi */
;(function () {
  "use strict"
  const vscode = acquireVsCodeApi()
  const app = document.getElementById("app")
  let state = null
  let choices = { agents: [], models: [], defaultModel: undefined }
  let selection = {}
  let local = { servers: [], failures: [], expected: [] }
  let slots = null
  let toolcheck = null
  let pullName = ""
  let sessions = []
  let trust = null
  let connectable = []
  let suggestions = { kind: "", seq: 0, items: [], index: 0 }
  let suggestSeq = 0
  let notice = ""

  const el = (tag, props, ...children) => {
    const node = document.createElement(tag)
    for (const [k, v] of Object.entries(props || {})) {
      if (k === "class") node.className = v
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v)
      else if (v !== undefined && v !== false) node.setAttribute(k, v === true ? "" : v)
    }
    for (const child of children.flat()) if (child !== undefined && child !== null && child !== false) node.append(child)
    return node
  }

  // Text is rendered only through textContent: model output is never interpreted as HTML.
  function renderText(text) {
    const out = []
    const re = /```([^\n`]*)\n([\s\S]*?)(```|$)/g
    let last = 0
    let m
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) paragraphs(text.slice(last, m.index), out)
      out.push(el("pre", {}, el("code", {}, m[2].replace(/\n$/, ""))))
      last = re.lastIndex
      if (m[3] === "") break
    }
    if (last < text.length) paragraphs(text.slice(last), out)
    return out
  }
  function paragraphs(text, out) {
    for (const block of text.split(/\n{2,}/)) if (block.trim() !== "") out.push(el("p", {}, block.trim()))
  }

  const short = (value, n = 80) => {
    const s = typeof value === "string" ? value : JSON.stringify(value)
    return s && s.length > n ? s.slice(0, n - 1) + "…" : s || ""
  }
  const mark = (status) => ({ pending: "◌", running: "◐", completed: "●", error: "✕" })[status] || "·"

  function toolCard(part) {
    const s = part.state || {}
    const input = s.input && typeof s.input === "object" ? s.input : {}
    const sub = s.title || input.filePath || input.path || input.command || input.pattern || ""
    const body = []
    if (s.status === "completed") body.push(el("pre", {}, short(s.output, 4000)))
    else if (s.status === "error") body.push(el("pre", {}, short(s.error, 4000)))
    else body.push(el("pre", {}, short(input, 1000)))
    return el("details", { class: "card" }, el("summary", {}, el("span", { class: "mark" }, mark(s.status)), el("span", { class: "name" }, part.tool), el("span", { class: "sub" }, short(sub, 120))), body)
  }

  function partNode(part) {
    switch (part.type) {
      case "text":
        return part.synthetic ? null : el("div", {}, renderText(part.text))
      case "reasoning":
        return part.text ? el("details", { class: "card reasoning" }, el("summary", {}, el("span", { class: "name" }, "Thinking")), el("pre", {}, part.text)) : null
      case "tool":
        return toolCard(part)
      case "patch":
        return el("details", { class: "card" }, el("summary", {}, el("span", { class: "mark" }, "±"), el("span", { class: "name" }, "Changed"), el("span", { class: "sub" }, part.files.length + " file(s)")),
          el("div", {}, part.files.map((f) => el("div", {}, el("a", { href: "#", onclick: (e) => { e.preventDefault(); vscode.postMessage({ type: "open", path: f }) } }, f)))))
      case "file":
        return el("div", { class: "sub" }, "attachment: " + (part.filename || part.mime))
      default:
        return null
    }
  }

  function messageNode(message) {
    const nodes = (message.parts || []).map(partNode).filter(Boolean)
    if (message.role === "user") {
      if (!nodes.length) return null
      return el("div", { class: "msg user" }, nodes, state.busy ? null : el("button", { class: "undo", title: "Undo this message and the file changes it caused", onclick: () => vscode.postMessage({ type: "revert", messageID: message.id }) }, "Undo"))
    }
    const err = message.error ? el("div", { class: "error" }, message.error.message) : null
    return nodes.length || err ? el("div", { class: "msg assistant" }, nodes, err) : null
  }

  // How full the context window is, from the last response's input tokens and the model's limit.
  function contextUse() {
    const model = choices.models.find((m) => m.value === (selection.model || choices.defaultModel))
    const last = [...state.messages].reverse().find((m) => m.role === "assistant" && m.tokens)
    if (!model || !model.context || !last) return null
    const used = (last.tokens.input || 0) + (last.tokens.cacheRead || 0) + (last.tokens.output || 0)
    return { used, limit: model.context, pct: Math.min(100, Math.round((used / model.context) * 100)) }
  }
  const compact = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n))

  // Tokens per second of the last reply: the server's own timing when it reported one, else elapsed time (marked ~).
  function lastSpeed() {
    const last = [...state.messages].reverse().find((m) => m.role === "assistant" && m.tokens && m.tokens.output > 0 && m.time && m.time.completed)
    if (!last) return null
    const ms = last.timings && last.timings.generationMs
    if (ms > 0) return { value: last.tokens.output / (ms / 1000), approx: false }
    const elapsed = last.time.completed - last.time.created
    return elapsed > 0 ? { value: last.tokens.output / (elapsed / 1000), approx: true } : null
  }
  function currentModel() {
    return choices.models.find((m) => m.value === (selection.model || choices.defaultModel))
  }
  const MODE_WORDS = { "small-context": "small context window", "small-model": "small model", config: "set in config" }
  function modeChip() {
    const model = currentModel()
    if (!model || !model.mode || !model.mode.compactPrompt) return null
    return el("span", { class: "chip", title: "Compact prompt: shorter instructions and fewer tools (" + (MODE_WORDS[model.mode.compactReason] || "") + ")" }, "compact")
  }
  function toolcheckLine() {
    if (!toolcheck) return null
    if (toolcheck.running) return el("div", { class: "notice" }, "Asking " + toolcheck.model + " to call a tool…")
    const r = toolcheck.result || {}
    const words = {
      ok: "Tool calls work: the model answered with a structured call.",
      recovered: "Tool calls work, with help: the model wrote the call as text and Deberopa recovered it.",
      failed: "Tool calls do not work" + (r.detail ? ": " + r.detail : "") + ". The agent cannot read or edit files with this model.",
      unauthorized: "The server needs an API key (set OPERETA_API_KEY or LLAMA_API_KEY).",
      error: "The check could not run: " + (r.detail || "unknown error") + ".",
    }
    return el("div", { class: r.status === "ok" || r.status === "recovered" ? "notice" : "error", role: "status" }, words[r.status] || r.status)
  }

  function picker(key, options, current, label) {
    const select = el("select", { "aria-label": label, onchange: (e) => vscode.postMessage({ type: "select", key, value: e.target.value }) },
      options.map((o) => el("option", { value: o.value }, o.label)))
    select.value = current || ""
    return select
  }

  function pullProgress() {
    const rows = []
    for (const [key, p] of Object.entries(state.pulls || {})) {
      if (p.done && Date.now() - (p.finished || 0) > 15000) continue
      const pct = p.total && p.completed !== undefined ? Math.round((p.completed / p.total) * 100) : null
      const text = p.error ? "failed: " + p.error : p.done ? "ready — pick it in the model list" : p.status + (pct !== null ? " " + pct + "%" : "")
      rows.push(el("div", { class: "srv" }, el("span", { class: "mark" }, p.error ? "✕" : p.done ? "●" : "◐"), el("span", { class: "name" }, p.model), el("span", { class: "sub" }, text)))
    }
    return rows
  }

  function localCard() {
    const rows = local.servers.map((s) => {
      const o = s.opereta
      const detail = o
        ? ["Opereta " + o.version, o.state, o.slots ? o.slots + " slot" + (o.slots === 1 ? "" : "s") : o.slotsAuto ? "slots auto" : null, o.ctxPerSlot ? compact(o.ctxPerSlot) + " ctx/slot" : null].filter(Boolean).join(" · ")
        : s.models.length + " model" + (s.models.length === 1 ? "" : "s")
      const down = o && o.state && !/^running/.test(o.state)
      return el("div", {}, el("div", { class: "srv" }, el("span", { class: "mark" }, down ? "!" : "●"), el("span", { class: "name" }, s.name), el("span", { class: "sub" }, detail)),
        down && s.hint ? el("div", { class: "hint" }, s.hint) : null)
    })
    for (const f of local.failures) rows.push(el("div", { class: "srv" }, el("span", { class: "mark" }, "!"), el("span", { class: "name" }, f.id), el("span", { class: "sub" }, "needs an API key (HTTP " + f.status + ")")))
    const ollama = local.servers.find((s) => s.id === "ollama")
    const nothing = rows.length === 0
    return el("div", { class: "local" },
      el("div", { class: "head" }, el("strong", {}, "Local models"), el("button", { onclick: () => vscode.postMessage({ type: "rescanLocal" }) }, "Rescan")),
      rows,
      nothing ? el("div", { class: "sub" }, "No local model server answered. Start one and press Rescan:") : null,
      nothing ? (local.expected || []).map((e) => el("div", { class: "hint" }, el("strong", {}, e.name + " (port " + e.port + ")"), " — " + e.hint)) : null,
      ollama ? el("form", { class: "pull", onsubmit: (e) => { e.preventDefault(); const model = pullName.trim(); if (model) { vscode.postMessage({ type: "pull", provider: "ollama", model }); } } },
        el("input", { type: "text", value: pullName, placeholder: ollama.models.length ? "Download another model, e.g. qwen3:8b" : "No models yet. Download one, e.g. qwen3:8b", "aria-label": "Model to download", oninput: (e) => { pullName = e.target.value } }),
        el("button", { type: "submit" }, "Download")) : null,
      pullProgress())
  }

  function ago(ms) {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
    if (s < 60) return "now"
    if (s < 3600) return Math.round(s / 60) + "m"
    if (s < 86400) return Math.round(s / 3600) + "h"
    return Math.round(s / 86400) + "d"
  }

  function sessionPicker() {
    if (!sessions.length) return null
    const select = el("select", { class: "sessions", "aria-label": "Session", onchange: (e) => e.target.value && vscode.postMessage({ type: "switchSession", id: e.target.value }) },
      sessions.map((s) => el("option", { value: s.id }, s.title + " · " + ago(s.updated))))
    select.value = state.sessionID || ""
    return select
  }

  function trustBanner() {
    if (!trust || trust.trusted || !trust.blocked || !trust.blocked.length) return null
    return el("div", { class: "notice", role: "alert" },
      el("div", {}, el("strong", {}, "This project's config is not trusted"), " — it asks to run programs or set endpoints, so it is ignored until you trust it:"),
      el("ul", {}, trust.blocked.slice(0, 6).map((b) => el("li", {}, b))),
      el("button", { class: "primary", onclick: () => vscode.postMessage({ type: "grantTrust" }) }, "Trust this project"))
  }

  let keyProvider = ""
  let keyText = ""
  function connectCard() {
    if (choices.models.length || !connectable.length) return null
    return el("div", { class: "local" },
      el("div", { class: "head" }, el("strong", {}, "Use a hosted model instead")),
      el("div", { class: "sub" }, "Local models come first (start a server above). To use a hosted model, add its API key. It is stored in your user data, never in the project."),
      el("form", { class: "pull", onsubmit: (e) => { e.preventDefault(); const p = keyProvider || connectable[0].id; if (keyText.trim()) { vscode.postMessage({ type: "connect", provider: p, key: keyText.trim() }); keyText = "" } } },
        el("select", { "aria-label": "Provider", onchange: (e) => { keyProvider = e.target.value } }, connectable.map((p) => el("option", { value: p.id }, p.name))),
        el("input", { type: "password", autocomplete: "off", placeholder: "API key", "aria-label": "API key", oninput: (e) => { keyText = e.target.value } }),
        el("button", { type: "submit" }, "Save")))
  }

  function renderSuggestions() {
    const box = document.getElementById("suggest")
    if (!box) return
    box.replaceChildren(...suggestions.items.map((it, i) => el("div", { class: "opt" + (i === suggestions.index ? " on" : ""), onmousedown: (e) => { e.preventDefault(); applySuggestion(it) } },
      el("span", {}, it.label), it.hint ? el("span", { class: "sub" }, it.hint) : null)))
    box.style.display = suggestions.items.length ? "block" : "none"
  }
  function applySuggestion(item) {
    const input = document.getElementById("input")
    if (!input) return
    const upto = input.value.slice(0, input.selectionStart)
    const rest = input.value.slice(input.selectionStart)
    const token = /(^|\s)([@/][^\s]*)$/.exec(upto)
    if (token) {
      const start = upto.length - token[2].length
      input.value = input.value.slice(0, start) + item.value + (item.value.endsWith(" ") ? "" : " ") + rest
      const at = start + item.value.length + (item.value.endsWith(" ") ? 0 : 1)
      input.setSelectionRange(at, at)
    }
    suggestions = { kind: "", seq: 0, items: [], index: 0 }
    renderSuggestions()
    input.focus()
  }
  function maybeSuggest(input) {
    const upto = input.value.slice(0, input.selectionStart)
    const file = /(^|\s)@([^\s]*)$/.exec(upto)
    const cmd = upto.indexOf("\n") === -1 ? /^\/([^\s]*)$/.exec(upto) : null
    if (!file && !cmd) { suggestions = { kind: "", seq: 0, items: [], index: 0 }; return renderSuggestions() }
    suggestSeq++
    vscode.postMessage({ type: "suggest", kind: file ? "file" : "command", query: file ? file[2] : cmd[1], seq: suggestSeq })
  }

  function render() {
    if (!state) return
    const log = document.getElementById("log")
    const stick = !log || log.scrollHeight - log.scrollTop - log.clientHeight < 40
    const draft = document.getElementById("input")
    const draftText = draft ? draft.value : ""
    const hadFocus = draft && document.activeElement === draft

    const messages = state.messages.map(messageNode).filter(Boolean)
    const root = el("div", { id: "root", style: "display:contents" },
      el("header", {},
        el("span", { class: "title" }, state.title || "Deberopa"),
        state.busy ? el("span", { class: "busy" }, state.retry ? "retrying…" : "working…") : null,
        modeChip(),
        (() => {
          const sp = lastSpeed()
          return sp ? el("span", { class: "busy", title: sp.approx ? "Output tokens divided by response time" : "Reported by the model server" }, (sp.approx ? "~" : "") + (sp.value < 10 ? sp.value.toFixed(1) : Math.round(sp.value)) + " tok/s") : null
        })(),
        slots && slots.total > 0 ? el("span", { class: "busy", title: "Busy slots on the model server" }, "slots " + slots.busy + "/" + slots.total) : null,
        (() => {
          const u = contextUse()
          return u ? el("span", { class: "busy", title: `Context: ${u.used.toLocaleString()} of ${u.limit.toLocaleString()} tokens` }, `${compact(u.used)}/${compact(u.limit)} · ${u.pct}%`) : null
        })(),
        sessionPicker(),
        el("button", { onclick: () => vscode.postMessage({ type: "newSession" }), title: "New session" }, "New")),
      trustBanner(),
      el("div", { id: "log" }, messages.length ? messages : [el("div", { class: "empty" }, "Ask Deberopa to work on this project.\nUse @file to attach a file."), localCard(), connectCard()]),
      state.todos.length ? el("div", { class: "todos" }, el("strong", {}, "Todo"), el("ul", {}, state.todos.map((t) => el("li", { class: t.status === "completed" ? "done" : "" }, `${t.status === "completed" ? "● " : t.status === "in_progress" ? "◐ " : "○ "}${t.content}`)))) : null,
      state.permissions.map((p) => el("div", { class: "perm", role: "alert" },
        el("div", { class: "title" }, p.title || `${p.permission} permission`),
        el("div", { class: "sub" }, short((p.patterns || []).join(", "), 200)),
        el("div", { class: "buttons" },
          el("button", { class: "primary", onclick: () => vscode.postMessage({ type: "permission", id: p.id, reply: "once" }) }, "Allow once"),
          el("button", { onclick: () => vscode.postMessage({ type: "permission", id: p.id, reply: "always" }) }, "Always allow"),
          el("button", { onclick: () => vscode.postMessage({ type: "permission", id: p.id, reply: "reject" }) }, "Reject")))),
      state.error ? el("div", { class: "error", role: "alert" }, state.error.message) : null,
      toolcheckLine(),
      notice ? el("div", { class: "notice" }, notice) : null,
      el("footer", {},
        el("div", { class: "box" },
          el("div", { id: "suggest", class: "suggest", style: "display:none" }),
          el("textarea", { id: "input", rows: "2", placeholder: "Message Deberopa  (Enter to send, Shift+Enter for a new line)", "aria-label": "Message" }),
          el("div", { class: "row" },
            el("span", { class: "pickers" },
              choices.agents.length ? picker("agent", choices.agents.map((a) => ({ value: a.name, label: a.name })), selection.agent || (choices.agents[0] && choices.agents[0].name), "Agent") : null,
              choices.models.length ? picker("model", choices.models, selection.model || choices.defaultModel, "Model") : null,
              choices.models.length ? el("button", { title: "Ask the model to call a tool once, to see whether it can drive the agent", onclick: () => vscode.postMessage({ type: "toolcheck", model: selection.model || choices.defaultModel }) }, "Check tools") : null),
            state.busy
              ? el("button", { onclick: () => vscode.postMessage({ type: "abort" }) }, "Stop")
              : el("button", { class: "primary", id: "send" }, "Send")))))
    app.replaceChildren(root)

    const input = document.getElementById("input")
    input.value = draftText
    const submit = () => {
      const text = input.value.trim()
      if (text === "" || state.busy) return
      vscode.postMessage({ type: "send", text })
      input.value = ""
    }
    input.addEventListener("input", () => maybeSuggest(input))
    input.addEventListener("keydown", (e) => {
      if (suggestions.items.length) {
        if (e.key === "ArrowDown") { e.preventDefault(); suggestions.index = (suggestions.index + 1) % suggestions.items.length; return renderSuggestions() }
        if (e.key === "ArrowUp") { e.preventDefault(); suggestions.index = (suggestions.index - 1 + suggestions.items.length) % suggestions.items.length; return renderSuggestions() }
        if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) { e.preventDefault(); return applySuggestion(suggestions.items[suggestions.index]) }
        if (e.key === "Escape") { suggestions = { kind: "", seq: 0, items: [], index: 0 }; return renderSuggestions() }
      }
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit() }
    })
    const send = document.getElementById("send")
    if (send) send.addEventListener("click", submit)
    if (hadFocus || !draft) input.focus()
    const newLog = document.getElementById("log")
    if (stick) newLog.scrollTop = newLog.scrollHeight
  }

  window.addEventListener("message", (event) => {
    const m = event.data
    if (m.type === "state") { sessions = m.sessions || []; trust = m.trust || null; connectable = m.connectable || []; slots = m.slots || null; toolcheck = m.toolcheck || null; local = m.local || local; state = m.state; choices = m.choices || choices; selection = m.selection || {}; notice = ""; render() }
    else if (m.type === "suggestions") {
      if (m.seq === suggestSeq) { suggestions = { kind: m.kind, seq: m.seq, items: m.items || [], index: 0 }; renderSuggestions() }
    }
    else if (m.type === "notice") { notice = m.text; render() }
    else if (m.type === "insert") {
      const input = document.getElementById("input")
      if (input) { input.value += (input.value && !input.value.endsWith(" ") ? " " : "") + m.text; input.focus() }
    }
  })
  vscode.postMessage({ type: "ready" })
})()
