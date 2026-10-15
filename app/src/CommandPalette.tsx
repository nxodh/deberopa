import { useEffect, useMemo, useRef, useState } from "react"
import { request } from "./bridge"
import { newSession, openFile, openModels, openProject, openSettings, openTerminalTab, setActive, useStore } from "./store"

interface Item {
  id: string
  label: string
  hint?: string
  run: () => void
}

/** Cmd/Ctrl+K: actions, open tabs and files of the active project in one list. */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const tabs = useStore((s) => s.tabs)
  const activeID = useStore((s) => s.active)
  const projects = useStore((s) => s.projects)
  const order = useStore((s) => s.order)
  const dir = useStore((s) => (s.tabs.find((t) => t.id === s.active)?.dir ?? s.order[0]))
  const [query, setQuery] = useState("")
  const [files, setFiles] = useState<string[]>([])
  const [index, setIndex] = useState(0)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => input.current?.focus(), [])
  useEffect(() => {
    if (!dir || query.trim().length < 2) return setFiles([])
    let cancelled = false
    const timer = setTimeout(() => {
      void request<string[]>(dir, "GET", `/find/file?query=${encodeURIComponent(query.trim())}&limit=8`).then(
        (r) => !cancelled && setFiles(r),
        () => {},
      )
    }, 120)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, dir])

  const items = useMemo<Item[]>(() => {
    const list: Item[] = [{ id: "open", label: "Open a project folder…", run: () => void openProject() }]
    if (dir) {
      list.push(
        { id: "new-session", label: "New session", hint: projects[dir]?.name, run: () => void newSession(dir) },
        { id: "terminal", label: "New terminal", hint: projects[dir]?.name, run: () => openTerminalTab(dir) },
        { id: "models", label: "Models and servers", run: () => openModels(dir) },
        { id: "settings", label: "Settings", run: () => openSettings(dir) },
      )
    }
    for (const t of tabs) {
      const label = t.kind === "file" ? t.path : t.kind === "session" ? (projects[t.dir]?.sessions.find((s) => s.id === t.sessionID)?.title ?? "Session") : t.kind === "terminal" ? `Terminal ${t.n}` : t.kind === "diff" ? "Changes" : t.kind === "settings" ? "Settings" : "Models and servers"
      list.push({ id: `tab:${t.id}`, label: `Go to: ${label}`, hint: projects[t.dir]?.name, run: () => setActive(t.id) })
    }
    for (const f of files) if (dir) list.push({ id: `file:${f}`, label: `Open file: ${f}`, run: () => openFile(dir, f) })
    return list
  }, [tabs, projects, dir, files, order])

  const shown = items.filter((i) => `${i.label} ${i.hint ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()) || i.id.startsWith("file:"))
  useEffect(() => setIndex(0), [query])
  void activeID

  const run = (item?: Item) => {
    if (!item) return
    onClose()
    item.run()
  }

  return (
    <div className="palette-backdrop" onMouseDown={onClose} data-testid="palette">
      <div className="palette" role="dialog" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={input}
          type="text"
          value={query}
          placeholder="Type a command or a file name"
          aria-label="Command"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose()
            else if (e.key === "ArrowDown") {
              e.preventDefault()
              setIndex((i) => Math.min(shown.length - 1, i + 1))
            } else if (e.key === "ArrowUp") {
              e.preventDefault()
              setIndex((i) => Math.max(0, i - 1))
            } else if (e.key === "Enter") run(shown[index])
          }}
        />
        <div className="palette-list">
          {shown.slice(0, 12).map((item, i) => (
            <button key={item.id} className={`palette-item${i === index ? " active" : ""}`} onMouseEnter={() => setIndex(i)} onClick={() => run(item)}>
              <span>{item.label}</span>
              {item.hint ? <span className="sub">{item.hint}</span> : null}
            </button>
          ))}
          {shown.length === 0 ? <div className="sub palette-empty">Nothing matches.</div> : null}
        </div>
      </div>
    </div>
  )
}
