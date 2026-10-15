import { useEffect, useState } from "react"
import { request } from "./bridge"
import { grantTrust, notify, refreshProject, useStore } from "./store"
import { compactNumber } from "./text"

interface Status {
  version: string
  directory: string
  configFile: string
  mcp: { name: string; status: string; error?: string; tools: number }[]
  lsp: { id: string; root: string; connected: boolean }[]
  plugins: { name: string; source: string }[]
  pluginProblems: { name?: string; file?: string; error?: string; message?: string }[]
  snapshot: { available: boolean; reason?: string }
}
interface Stats {
  sessions: number
  messages: number
  tokens: number
  cost: number
  models: { model: string; messages: number; input: number; output: number; cache: number; cost: number }[]
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function SettingsView({ dir }: { dir: string }) {
  const project = useStore((s) => s.projects[dir])
  const [status, setStatus] = useState<Status | undefined>()
  const [stats, setStats] = useState<Stats | undefined>()
  const [auth, setAuth] = useState<{ id: string; name: string; type: string; source: string }[]>([])
  const [providers, setProviders] = useState<{ id: string; name: string; local: boolean; connected: boolean }[]>([])
  const [trust, setTrust] = useState<{ trusted: boolean; blocked: string[] } | undefined>()
  const [pick, setPick] = useState("")
  const [key, setKey] = useState("")
  const [error, setError] = useState("")

  const load = async () => {
    try {
      const [s, st, a, p, t] = await Promise.all([
        request<Status>(dir, "GET", "/status"),
        request<Stats>(dir, "GET", "/stats").catch(() => undefined),
        request<any[]>(dir, "GET", "/auth"),
        request<any>(dir, "GET", "/provider"),
        request<any>(dir, "GET", "/trust").catch(() => undefined),
      ])
      setStatus(s)
      setStats(st)
      setAuth(a)
      setProviders(p.providers.map((x: any) => ({ id: x.id, name: x.name, local: !!x.local, connected: !!x.connected })))
      setTrust(t ? { trusted: !!t.trusted, blocked: t.blocked ?? [] } : undefined)
    } catch (err) {
      setError(errText(err))
    }
  }
  useEffect(() => {
    void load()
  }, [dir])

  const saveKey = async () => {
    if (!pick || !key.trim()) return
    try {
      await request(dir, "PUT", `/auth/${encodeURIComponent(pick)}`, { key: key.trim() })
      setKey("")
      setPick("")
      notify("Key saved.")
      await load()
      await refreshProject(dir)
    } catch (err) {
      setError(errText(err))
    }
  }
  const removeKey = async (id: string) => {
    try {
      await request(dir, "DELETE", `/auth/${encodeURIComponent(id)}`)
      await load()
      await refreshProject(dir)
    } catch (err) {
      setError(errText(err))
    }
  }
  const setTrusted = async (value: boolean) => {
    try {
      if (value) await grantTrust(dir)
      else await request(dir, "DELETE", "/trust")
      await load()
      await refreshProject(dir)
    } catch (err) {
      setError(errText(err))
    }
  }

  const hosted = providers.filter((p) => !p.local && !p.connected).sort((a, b) => a.name.localeCompare(b.name))
  const models = Array.isArray(stats?.models) ? stats!.models! : []

  return (
    <div className="models" data-testid="settings">
      <h2>Settings</h2>
      <p className="sub">
        {project?.name} · {status?.directory}
      </p>
      {error ? <div className="error">{error}</div> : null}

      <section>
        <h3>API keys</h3>
        <p className="sub">For hosted models. Keys are stored in your user data folder (owner read/write only) and never shown again. Models on your own computers need no key.</p>
        {auth.length === 0 ? <div className="sub">No keys stored.</div> : null}
        {auth.map((a) => (
          <div key={a.id} className="srv">
            <span className="mark">●</span>
            <span className="name">{a.name}</span>
            <span className="sub">{a.source === "stored" ? "stored key" : a.source}</span>
            <span className="spacer" />
            {a.source === "stored" ? <button onClick={() => void removeKey(a.id)}>Remove</button> : null}
          </div>
        ))}
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault()
            void saveKey()
          }}
        >
          <select aria-label="Provider" value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">Add a key for…</option>
            {hosted.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <input type="password" value={key} placeholder="API key" aria-label="API key" autoComplete="off" onChange={(e) => setKey(e.target.value)} />
          <button type="submit" className="primary" disabled={!pick || !key.trim()}>
            Save
          </button>
        </form>
      </section>

      <section>
        <h3>This project</h3>
        {trust ? (
          <div className="srv">
            <span className="mark">{trust.trusted ? "●" : "○"}</span>
            <span className="name">{trust.trusted ? "Trusted" : "Not trusted"}</span>
            <span className="sub">{trust.trusted ? "Its config may run programs and set endpoints." : "Its config cannot run programs or set endpoints."}</span>
            <span className="spacer" />
            <button onClick={() => void setTrusted(!trust.trusted)}>{trust.trusted ? "Stop trusting" : "Trust this project"}</button>
          </div>
        ) : null}
        {trust && trust.blocked.length ? (
          <ul className="sub">
            {trust.blocked.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        ) : null}
        <div className="srv">
          <span className="name">Undo and diffs</span>
          <span className="sub">{status?.snapshot.available ? "available" : `not available: ${status?.snapshot.reason ?? "unknown"}`}</span>
        </div>
      </section>

      <section>
        <h3>Connected tools</h3>
        <div className="sub">MCP servers</div>
        {status && status.mcp.length === 0 ? <div className="sub">None configured.</div> : null}
        {status?.mcp.map((m) => (
          <div key={m.name} className="srv">
            <span className="mark">{m.status === "connected" ? "●" : m.status === "failed" ? "✕" : "◌"}</span>
            <span className="name">{m.name}</span>
            <span className="sub">
              {m.status} · {m.tools} tool{m.tools === 1 ? "" : "s"}
              {m.error ? ` · ${m.error}` : ""}
            </span>
          </div>
        ))}
        <div className="sub">Language servers</div>
        {status && status.lsp.length === 0 ? <div className="sub">None running yet (they start when a matching file is edited).</div> : null}
        {status?.lsp.map((l) => (
          <div key={`${l.id}:${l.root}`} className="srv">
            <span className="mark">{l.connected ? "●" : "◌"}</span>
            <span className="name">{l.id}</span>
            <span className="sub">{l.root}</span>
          </div>
        ))}
        <div className="sub">Plugins</div>
        {status && status.plugins.length === 0 ? <div className="sub">None loaded.</div> : null}
        {status?.plugins.map((p) => (
          <div key={p.name} className="srv">
            <span className="mark">●</span>
            <span className="name">{p.name}</span>
            <span className="sub">{p.source}</span>
          </div>
        ))}
        {status?.pluginProblems.map((p, i) => (
          <div key={i} className="error small">
            {p.name ?? p.file}: {p.error ?? p.message}
          </div>
        ))}
      </section>

      <section>
        <h3>Usage</h3>
        {models.length === 0 ? (
          <div className="sub">Nothing recorded yet.</div>
        ) : (
          models.map((m) => (
            <div key={m.model} className="srv">
              <span className="name">{m.model}</span>
              <span className="sub">
                {compactNumber(m.input)} in · {compactNumber(m.output)} out{m.cost ? ` · $${m.cost.toFixed(2)}` : ""}
              </span>
            </div>
          ))
        )}
      </section>

      <section>
        <h3>About</h3>
        <div className="sub">Deberopa {status?.version}</div>
        <div className="sub">Config file: {status?.configFile}</div>
      </section>
    </div>
  )
}
