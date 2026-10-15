import { useEffect, useRef, useState } from "react"
import type { Message, Part } from "./conv"
import { abort, compactSession, convKey, replyPermission, select, send, undoMessage, useStore, type ModelChoice, type Tab } from "./store"
import { compactNumber, short, Text } from "./text"

const MARK: Record<string, string> = { pending: "◌", running: "◐", completed: "●", error: "✕" }

function ToolCard({ part }: { part: Part }) {
  const s = part.state ?? {}
  const input = s.input && typeof s.input === "object" ? s.input : {}
  const sub = s.title || input.filePath || input.path || input.command || input.pattern || ""
  const body = s.status === "completed" ? short(s.output, 4000) : s.status === "error" ? short(s.error, 4000) : short(input, 1000)
  return (
    <details className="card" data-status={s.status}>
      <summary>
        <span className="mark">{MARK[s.status] ?? "·"}</span>
        <span className="name">{part.tool}</span>
        <span className="sub">{short(sub, 120)}</span>
        {part.viaText ? <span className="chip" title="The model wrote this call as text; Deberopa recovered it">via text</span> : null}
      </summary>
      <pre>{body}</pre>
    </details>
  )
}

function PartView({ part }: { part: Part }) {
  switch (part.type) {
    case "text":
      return part.synthetic ? null : (
        <div>
          <Text text={part.text ?? ""} />
        </div>
      )
    case "reasoning":
      return part.text ? (
        <details className="card reasoning">
          <summary>
            <span className="name">Thinking</span>
          </summary>
          <pre>{part.text}</pre>
        </details>
      ) : null
    case "tool":
      return <ToolCard part={part} />
    case "patch":
      return (
        <details className="card">
          <summary>
            <span className="mark">±</span>
            <span className="name">Changed</span>
            <span className="sub">{(part.files ?? []).length} file(s)</span>
          </summary>
          <div className="files">
            {(part.files ?? []).map((f: string) => (
              <div key={f}>{f}</div>
            ))}
          </div>
        </details>
      )
    case "file":
      return <div className="sub">attachment: {part.filename || part.mime}</div>
    default:
      return null
  }
}

function MessageView({ message, busy, onUndo }: { message: Message; busy: boolean; onUndo: () => void }) {
  const nodes = (message.parts ?? []).filter((p) => !(p.type === "text" && p.synthetic))
  if (message.role === "user") {
    if (!nodes.length) return null
    return (
      <div className="msg user">
        {nodes.map((p) => (
          <PartView key={p.id} part={p} />
        ))}
        {busy ? null : (
          <button className="undo" title="Undo this message and the file changes it caused" onClick={onUndo}>
            Undo
          </button>
        )}
      </div>
    )
  }
  if (!nodes.length && !message.error) return null
  return (
    <div className="msg assistant">
      {nodes.map((p) => (
        <PartView key={p.id} part={p} />
      ))}
      {message.error ? <div className="error">{message.error.message}</div> : null}
    </div>
  )
}

function lastSpeed(messages: Message[]) {
  const last = [...messages].reverse().find((m) => m.role === "assistant" && m.tokens && m.tokens.output > 0 && m.time?.completed)
  if (!last) return null
  const ms = last.timings?.generationMs
  if (ms && ms > 0) return { value: last.tokens!.output / (ms / 1000), approx: false }
  const elapsed = last.time!.completed! - last.time!.created
  return elapsed > 0 ? { value: last.tokens!.output / (elapsed / 1000), approx: true } : null
}

export function contextUse(messages: Message[], model?: ModelChoice) {
  const last = [...messages].reverse().find((m) => m.role === "assistant" && m.tokens)
  if (!model || !model.context || !last) return null
  const used = (last.tokens!.input || 0) + (last.tokens!.cacheRead || 0) + (last.tokens!.output || 0)
  return { used, limit: model.context, pct: Math.min(100, Math.round((used / model.context) * 100)) }
}

export function SessionView({ tab }: { tab: Extract<Tab, { kind: "session" }> }) {
  const key = convKey(tab.dir, tab.sessionID)
  const conv = useStore((s) => s.convs[key])
  const project = useStore((s) => s.projects[tab.dir])
  const sel = useStore((s) => s.selection[tab.id])
  const [text, setText] = useState("")
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" })
  }, [conv?.messages, conv?.permissions.length])

  if (!conv || !project) return <div className="empty">Loading…</div>
  const modelValue = sel?.model ?? project.defaultModel ?? ""
  const model = project.models.find((m) => m.value === modelValue)
  const speed = lastSpeed(conv.messages)
  const use = contextUse(conv.messages, model)

  const submit = () => {
    const value = text.trim()
    if (!value || conv.busy) return
    setText("")
    void send(tab, value)
  }

  return (
    <div className="session" data-testid="session">
      <div className="messages" data-testid="messages">
        {conv.messages.length === 0 && conv.loaded ? (
          <div className="empty">
            <p>What should we work on in <strong>{project.name}</strong>?</p>
            <p className="sub">Ask a question, or describe a change. Use @file to point at a file, /command for your commands, !command to run a shell command.</p>
          </div>
        ) : null}
        {conv.messages.map((m) => (
          <MessageView key={m.id} message={m} busy={conv.busy} onUndo={() => void undoMessage(tab.dir, tab.sessionID, m.id)} />
        ))}
        {conv.todos.length ? (
          <div className="todos" aria-label="Plan">
            {conv.todos.map((t, i) => (
              <div key={i} className={`todo ${t.status}`}>
                <span className="mark">{t.status === "completed" ? "●" : t.status === "in_progress" ? "◐" : "○"}</span>
                {t.content}
              </div>
            ))}
          </div>
        ) : null}
        {conv.permissions.map((p) => (
          <div key={p.id} className="permission" role="alert">
            <div>
              <strong>Permission</strong> · {p.title ?? p.tool ?? "an action"}
            </div>
            <div className="row">
              <button className="primary" onClick={() => void replyPermission(tab.dir, p.id, "once")}>
                Allow once
              </button>
              <button onClick={() => void replyPermission(tab.dir, p.id, "always")}>Always allow</button>
              <button onClick={() => void replyPermission(tab.dir, p.id, "reject")}>Reject</button>
            </div>
          </div>
        ))}
        {conv.retry ? <div className="notice">The model did not answer; retrying… {short(conv.retry.message ?? "", 120)}</div> : null}
        {conv.error ? <div className="error">{conv.error.message}</div> : null}
        <div ref={bottom} />
      </div>

      <div className="composer">
        <textarea
          data-testid="composer"
          value={text}
          placeholder={conv.busy ? "Working… (Esc to stop)" : "Message Deberopa"}
          aria-label="Message"
          rows={3}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            } else if (e.key === "Escape" && conv.busy) void abort(tab.dir, tab.sessionID)
          }}
        />
        <div className="composer-bar">
          <select aria-label="Agent" value={sel?.agent ?? project.agents[0]?.name ?? ""} onChange={(e) => select(tab.id, { agent: e.target.value })}>
            {project.agents.map((a) => (
              <option key={a.name} value={a.name} title={a.description}>
                {a.name}
              </option>
            ))}
          </select>
          <select aria-label="Model" value={modelValue} onChange={(e) => select(tab.id, { model: e.target.value })}>
            {project.models.length === 0 ? <option value="">No model yet</option> : null}
            {project.models.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
          {model?.mode?.compactPrompt ? <span className="chip" title="Compact prompt: shorter instructions and fewer tools">compact</span> : null}
          {use ? (
            <span className="chip" title={`${use.used.toLocaleString("en-US")} of ${use.limit.toLocaleString("en-US")} tokens`}>
              {compactNumber(use.used)} / {compactNumber(use.limit)} · {use.pct}%
            </span>
          ) : null}
          {speed ? <span className="chip">{speed.approx ? "~" : ""}{speed.value.toFixed(1)} tok/s</span> : null}
          <span className="spacer" />
          <button onClick={() => void compactSession(tab.dir, tab.sessionID)} disabled={conv.busy || conv.messages.length === 0} title="Summarise older messages to free context">
            Compact
          </button>
          {conv.busy ? (
            <button onClick={() => void abort(tab.dir, tab.sessionID)}>Stop</button>
          ) : (
            <button className="primary" onClick={submit} disabled={text.trim() === ""} data-testid="send">
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
