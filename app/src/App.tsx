import { DiffView } from "./DiffView"
import { Editor } from "./Editor"
import { FileTree } from "./FileTree"
import { ModelsView } from "./ModelsView"
import { TerminalView } from "./TerminalView"
import { SessionView } from "./SessionView"
import { ago } from "./text"
import { closeProject, closeTab, deleteSession, grantTrust, newSession, notify, openModels, openProject, openSession, openTerminalTab, sessionTabID, setActive, useStore } from "./store"
import { useState } from "react"

function Files({ dir }: { dir: string }) {
  const [open, setOpen] = useState(true)
  return (
    <div className="files-section">
      <button className="section-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="mark">{open ? "▾" : "▸"}</span>Files
      </button>
      {open ? <FileTree dir={dir} /> : null}
    </div>
  )
}

function Sidebar() {
  const order = useStore((s) => s.order)
  const projects = useStore((s) => s.projects)
  const active = useStore((s) => s.active)
  const recents = useStore((s) => s.recents)
  return (
    <aside className="sidebar" aria-label="Projects">
      <div className="side-head">
        <strong>Deberopa</strong>
        <button onClick={() => void openProject()} title="Open a project folder" data-testid="open-project">
          Open folder
        </button>
      </div>
      <div className="side-body">
        {order.length === 0 ? (
          <div className="side-empty">
            <p>Open a project folder to start.</p>
            {recents.slice(0, 5).map((d) => (
              <button key={d} className="link" onClick={() => void openProject(d)} title={d}>
                {d.split(/[\\/]/).filter(Boolean).pop() ?? d}
              </button>
            ))}
          </div>
        ) : null}
        {order.map((dir) => {
          const p = projects[dir]
          if (!p) return null
          return (
            <div key={dir} className="project">
              <div className="project-head" title={dir}>
                <span className="name">{p.name}</span>
                <span className="spacer" />
                <button className="icon" title="New session" onClick={() => void newSession(dir)}>
                  +
                </button>
                <button className="icon" title="New terminal" onClick={() => openTerminalTab(dir)} data-testid="open-terminal">
                  ›_
                </button>
                <button className="icon" title="Models and servers" onClick={() => openModels(dir)} data-testid="open-models">
                  ⚙
                </button>
                <button className="icon" title="Close project" onClick={() => void closeProject(dir)}>
                  ×
                </button>
              </div>
              {p.status === "error" ? <div className="error small">{p.error}</div> : null}
              {p.sessions.slice(0, 40).map((s) => {
                const id = sessionTabID(dir, s.id)
                return (
                  <div key={s.id} className={`session-row${active === id ? " active" : ""}`}>
                    <button className="session-link" onClick={() => void openSession(dir, s.id)} title={s.title}>
                      <span className="title">{s.title || "New session"}</span>
                      <span className="sub">{ago(s.updated)}</span>
                    </button>
                    <button className="icon hide" title="Delete session" onClick={() => void deleteSession(dir, s.id)}>
                      ×
                    </button>
                  </div>
                )
              })}
              <Files dir={dir} />
            </div>
          )
        })}
      </div>
    </aside>
  )
}

function TabBar() {
  const tabs = useStore((s) => s.tabs)
  const active = useStore((s) => s.active)
  const convs = useStore((s) => s.convs)
  const projects = useStore((s) => s.projects)
  const dirty = useStore((s) => s.dirty)
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => {
        const conv = t.kind === "session" ? convs[`${t.dir}\u0000${t.sessionID}`] : undefined
        const label =
          t.kind === "session"
            ? conv?.title || projects[t.dir]?.sessions.find((x) => x.id === t.sessionID)?.title || "New session"
            : t.kind === "file"
              ? (t.path.split("/").pop() ?? t.path)
              : t.kind === "diff"
                ? `Changes${t.file ? `: ${t.file.split(/[\\/]/).pop()}` : ""}`
                : t.kind === "terminal"
                  ? `Terminal ${t.n}`
                  : "Models and servers"
        return (
          <div key={t.id} role="tab" aria-selected={active === t.id} className={`tab${active === t.id ? " active" : ""}`}>
            <button className="tab-main" onClick={() => setActive(t.id)} title={label}>
              {conv?.busy ? <span className="mark">◐</span> : null}
              {dirty[t.id] ? <span className="mark" title="Unsaved changes">•</span> : null}
              <span className="title">{label}</span>
              <span className="proj">{projects[t.dir]?.name}</span>
            </button>
            <button className="icon" aria-label="Close tab" onClick={() => closeTab(t.id)}>
              ×
            </button>
          </div>
        )
      })}
    </div>
  )
}

function StatusBar() {
  const active = useStore((s) => s.active)
  const tab = useStore((s) => s.tabs.find((t) => t.id === s.active))
  const project = useStore((s) => (tab ? s.projects[tab.dir] : undefined))
  const version = useStore((s) => s.version)
  const notice = useStore((s) => s.notice)
  void active
  return (
    <footer className="status">
      <span>{project ? project.dir : "No project open"}</span>
      <span className="spacer" />
      {notice ? (
        <button className="link" onClick={() => notify(undefined)} title="Dismiss">
          {notice}
        </button>
      ) : null}
      <span>Deberopa {version}</span>
    </footer>
  )
}

export function App() {
  const tabs = useStore((s) => s.tabs)
  const activeID = useStore((s) => s.active)
  const tab = useStore((s) => s.tabs.find((t) => t.id === s.active))
  const project = useStore((s) => (tab ? s.projects[tab.dir] : undefined))
  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        <TabBar />
        {project && project.trust && !project.trust.trusted && project.trust.blocked.length ? (
          <div className="banner" role="alert">
            <strong>This project&apos;s config is not trusted</strong> — it asks to run programs or set endpoints, so it is ignored until you trust it: {project.trust.blocked.slice(0, 4).join("; ")}
            <button className="primary" onClick={() => void grantTrust(project.dir)}>
              Trust this project
            </button>
          </div>
        ) : null}
        <div className="content">
          {/* every tab stays mounted so an unsaved edit, a draft or a running shell survives a switch */}
          {tabs.map((t) => (
            <div key={t.id} className="pane" hidden={t.id !== activeID}>
              {t.kind === "session" ? <SessionView tab={t} /> : null}
              {t.kind === "models" ? <ModelsView dir={t.dir} /> : null}
              {t.kind === "file" ? <Editor tab={t} /> : null}
              {t.kind === "diff" ? <DiffView tab={t} /> : null}
              {t.kind === "terminal" ? <TerminalView tab={t} active={t.id === activeID} /> : null}
            </div>
          ))}
          {!tab ? (
            <div className="empty big">
              <h1>Deberopa</h1>
              <p>An agent that works in your project folder, with models on this computer or another one.</p>
              <button className="primary" onClick={() => void openProject()}>
                Open a project folder
              </button>
            </div>
          ) : null}
        </div>
      </main>
      <StatusBar />
    </div>
  )
}
