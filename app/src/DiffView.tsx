import { useEffect, useState } from "react"
import { request } from "./bridge"
import { notify, openFile, relativeTo, type Tab } from "./store"

/** File names named by `diff --git a/x b/x` lines. */
export function filesInDiff(diff: string): string[] {
  const out: string[] = []
  for (const m of diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) out.push(m[2]!)
  return out
}

export function DiffView({ tab }: { tab: Extract<Tab, { kind: "diff" }> }) {
  const [diff, setDiff] = useState<string | undefined>()
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  const load = async () => {
    try {
      const query = `hash=${encodeURIComponent(tab.hash)}${tab.file ? `&file=${encodeURIComponent(tab.file)}` : ""}`
      const res = await request<{ diff: string }>(tab.dir, "GET", `/snapshot/diff?${query}`)
      setDiff(res.diff)
      setError("")
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  useEffect(() => {
    void load()
  }, [tab.dir, tab.hash, tab.file])

  const files = diff ? filesInDiff(diff) : []

  const revert = async (list: string[]) => {
    const label = list.length === 1 ? list[0] : `${list.length} files`
    if (!window.confirm(`Put ${label} back to how it was before the agent's change? Your later edits to ${list.length === 1 ? "it" : "them"} are lost.`)) return
    setBusy(true)
    try {
      await request(tab.dir, "POST", "/snapshot/revert", { hash: tab.hash, files: list })
      notify(`Reverted ${label}.`)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const lines = (diff ?? "").split("\n")
  const rel = tab.file ? relativeTo(tab.dir, tab.file) : undefined

  return (
    <div className="diff" data-testid="diff">
      <div className="editor-bar">
        <span className="name">{rel ?? "All changes"}</span>
        <span className="sub">{files.length} file{files.length === 1 ? "" : "s"}</span>
        <span className="spacer" />
        {rel ? (
          <button onClick={() => openFile(tab.dir, rel)} title="Open the file in the editor">
            Edit
          </button>
        ) : null}
        <button onClick={() => void load()}>Refresh</button>
        <button disabled={busy || files.length === 0} onClick={() => void revert(rel ? [rel] : files)} data-testid="revert">
          {rel ? "Revert this file" : "Revert all"}
        </button>
      </div>
      {error ? <div className="error">{error}</div> : null}
      {diff !== undefined && diff.trim() === "" ? <div className="empty">No changes since that step: the files are as they were.</div> : null}
      <pre className="diff-body">
        {lines.map((line, i) => {
          const kind = line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ") ? "meta" : line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx"
          return (
            <div key={i} className={`dl ${kind}`}>
              {line === "" ? " " : line}
            </div>
          )
        })}
      </pre>
    </div>
  )
}
