/* global acquireVsCodeApi */
;(function () {
  "use strict"
  const vscode = acquireVsCodeApi()
  const app = document.getElementById("app")
  let state = null
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
    if (message.role === "user") return nodes.length ? el("div", { class: "msg user" }, nodes) : null
    const err = message.error ? el("div", { class: "error" }, message.error.message) : null
    return nodes.length || err ? el("div", { class: "msg assistant" }, nodes, err) : null
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
        el("button", { onclick: () => vscode.postMessage({ type: "newSession" }), title: "New session" }, "New")),
      el("div", { id: "log" }, messages.length ? messages : el("div", { class: "empty" }, "Ask Deberopa to work on this project.\nUse @file to attach a file.")),
      state.todos.length ? el("div", { class: "todos" }, el("strong", {}, "Todo"), el("ul", {}, state.todos.map((t) => el("li", { class: t.status === "completed" ? "done" : "" }, `${t.status === "completed" ? "● " : t.status === "in_progress" ? "◐ " : "○ "}${t.content}`)))) : null,
      state.permissions.map((p) => el("div", { class: "perm", role: "alert" },
        el("div", { class: "title" }, p.title || `${p.permission} permission`),
        el("div", { class: "sub" }, short((p.patterns || []).join(", "), 200)),
        el("div", { class: "buttons" },
          el("button", { class: "primary", onclick: () => vscode.postMessage({ type: "permission", id: p.id, reply: "once" }) }, "Allow once"),
          el("button", { onclick: () => vscode.postMessage({ type: "permission", id: p.id, reply: "always" }) }, "Always allow"),
          el("button", { onclick: () => vscode.postMessage({ type: "permission", id: p.id, reply: "reject" }) }, "Reject")))),
      state.error ? el("div", { class: "error", role: "alert" }, state.error.message) : null,
      notice ? el("div", { class: "notice" }, notice) : null,
      el("footer", {},
        el("div", { class: "box" },
          el("textarea", { id: "input", rows: "2", placeholder: "Message Deberopa  (Enter to send, Shift+Enter for a new line)", "aria-label": "Message" }),
          el("div", { class: "row" },
            el("span", {}, "@file  ·  @file#L10-20"),
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
    input.addEventListener("keydown", (e) => {
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
    if (m.type === "state") { state = m.state; notice = ""; render() }
    else if (m.type === "notice") { notice = m.text; render() }
    else if (m.type === "insert") {
      const input = document.getElementById("input")
      if (input) { input.value += (input.value && !input.value.endsWith(" ") ? " " : "") + m.text; input.focus() }
    }
  })
  vscode.postMessage({ type: "ready" })
})()
