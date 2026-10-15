import { useEffect, useState } from "react"
import { openFile, useStore } from "./store"

interface Entry {
  name: string
  dir: boolean
}

function Level({ dir, rel, depth }: { dir: string; rel: string; depth: number }) {
  const [entries, setEntries] = useState<Entry[] | undefined>()
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [error, setError] = useState("")

  useEffect(() => {
    let cancelled = false
    void window.deberopa.listDir(dir, rel || ".").then((res) => {
      if (cancelled) return
      if (res.ok) setEntries(res.entries ?? [])
      else setError(res.error ?? "Could not list this folder.")
    })
    return () => {
      cancelled = true
    }
  }, [dir, rel])

  if (error) return <div className="error small">{error}</div>
  if (!entries) return null
  return (
    <>
      {entries.map((e) => {
        const child = rel ? `${rel}/${e.name}` : e.name
        return (
          <div key={e.name}>
            <button
              className="tree-row"
              style={{ paddingLeft: 10 + depth * 12 }}
              data-testid={`file-${child}`}
              title={child}
              onClick={() => (e.dir ? setOpen((o) => ({ ...o, [e.name]: !o[e.name] })) : openFile(dir, child))}
            >
              <span className="mark">{e.dir ? (open[e.name] ? "▾" : "▸") : ""}</span>
              <span className="title">{e.name}</span>
            </button>
            {e.dir && open[e.name] ? <Level dir={dir} rel={child} depth={depth + 1} /> : null}
          </div>
        )
      })}
    </>
  )
}

export function FileTree({ dir }: { dir: string }) {
  // a new file made by the agent shows up when a session in this project finishes a turn
  const tick = useStore((s) => Object.entries(s.convs).filter(([k, c]) => k.startsWith(`${dir}\u0000`) && !c.busy).length + ":" + Object.entries(s.convs).filter(([k]) => k.startsWith(`${dir}\u0000`)).reduce((n, [, c]) => n + c.messages.length, 0))
  return <Level key={tick} dir={dir} rel="" depth={0} />
}
