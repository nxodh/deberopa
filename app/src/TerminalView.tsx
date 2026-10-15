import { FitAddon } from "@xterm/addon-fit"
import { Terminal } from "@xterm/xterm"
import "@xterm/xterm/css/xterm.css"
import { useEffect, useRef, useState } from "react"
import { request } from "./bridge"
import type { Tab } from "./store"

const cssVar = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback

export function TerminalView({ tab, active }: { tab: Extract<Tab, { kind: "terminal" }>; active: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)
  const [state, setState] = useState<"starting" | "running" | "ended">("starting")
  const [note, setNote] = useState("")
  const [run, setRun] = useState(0)

  useEffect(() => {
    const t = new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: { background: cssVar("--bg", "#ffffff"), foreground: cssVar("--text", "#111111"), cursor: cssVar("--text", "#111111"), selectionBackground: cssVar("--active", "#e2e2e2") },
    })
    const f = new FitAddon()
    t.loadAddon(f)
    t.open(host.current!)
    term.current = t
    fit.current = f
    let id = ""
    let pty = true
    let off: (() => void) | undefined
    let disposed = false
    f.fit()

    void (async () => {
      try {
        const info = await request<{ id: string; pty: boolean; shell: string }>(tab.dir, "POST", "/pty", { cols: t.cols, rows: t.rows })
        if (disposed) {
          void request(tab.dir, "DELETE", `/pty/${info.id}`).catch(() => {})
          return
        }
        id = info.id
        pty = info.pty
        setState("running")
        if (!pty) setNote("This shell has no pseudo-terminal here: full-screen programs may not work.")
        off = window.deberopa.onEvent(({ dir, event }) => {
          if (dir !== tab.dir) return
          const p = event.properties
          if (event.type === "pty.data" && p.id === id) t.write(p.data)
          else if (event.type === "pty.exit" && p.id === id) {
            t.write("\r\n[the shell ended]\r\n")
            setState("ended")
          }
        })
      } catch (err) {
        t.write(`\r\nCould not start a terminal: ${err instanceof Error ? err.message : String(err)}\r\n`)
        setState("ended")
      }
    })()

    t.onData((data) => {
      if (!id) return
      if (!pty) {
        // plain pipes do not echo: show what is typed and turn Enter into a line end
        for (const ch of data) {
          if (ch === "\r") t.write("\r\n")
          else if (ch === "\x7f") t.write("\b \b")
          else if (ch >= " ") t.write(ch)
        }
        data = data.replace(/\r/g, "\r\n")
      }
      void request(tab.dir, "POST", `/pty/${id}/input`, { data }).catch(() => {})
    })
    const resize = () => {
      try {
        f.fit()
      } catch {}
      if (id) void request(tab.dir, "POST", `/pty/${id}/resize`, { cols: t.cols, rows: t.rows }).catch(() => {})
    }
    const observer = new ResizeObserver(() => {
      if (host.current && host.current.offsetWidth > 0) resize()
    })
    observer.observe(host.current!)

    return () => {
      disposed = true
      observer.disconnect()
      off?.()
      if (id) void request(tab.dir, "DELETE", `/pty/${id}`).catch(() => {})
      t.dispose()
    }
  }, [tab.dir, run])

  useEffect(() => {
    if (active) term.current?.focus()
  }, [active])

  return (
    <div className="terminal" data-testid="terminal">
      {note ? <div className="notice small">{note}</div> : null}
      {state === "ended" ? (
        <div className="banner">
          <span>The shell ended.</span>
          <button onClick={() => setRun((n) => n + 1)}>Start a new one</button>
        </div>
      ) : null}
      <div className="terminal-host" ref={host} />
    </div>
  )
}
