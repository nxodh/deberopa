import { useEffect, useState } from "react"
import { request } from "./bridge"
import { refreshProject, useStore } from "./store"
import { compactNumber } from "./text"

interface LocalServer {
  id: string
  name: string
  models: { id: string; context?: number }[]
  opereta?: { version: string; state?: string; slots?: number; slotsAuto?: boolean; ctxPerSlot?: number }
  hint?: string
}
interface LocalInfo {
  servers: LocalServer[]
  failures: { id: string; baseURL: string; status: number }[]
  expected: { kind: string; name: string; port: number; hint: string }[]
  disabled: boolean
}
interface RemoteHost {
  id: string
  name: string
  url: string
  protocol: string
  hasKey: boolean
  hasCA: boolean
}
interface Check {
  ok: boolean
  url: string
  latencyMs?: number
  server?: { kind: string; name: string; models: { id: string; context?: number; details?: string }[]; opereta?: LocalServer["opereta"] }
  problem?: { code: string; message: string }
}
interface Pull {
  provider: string
  model: string
  status: string
  completed?: number
  total?: number
  done: boolean
  error?: string
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

function CheckLines({ check }: { check: Check }) {
  if (check.server) {
    const s = check.server
    return (
      <div className="check ok">
        <div>
          {s.name} · {check.url}
          {check.latencyMs !== undefined ? ` · ${check.latencyMs} ms` : ""}
          {s.opereta ? ` · Opereta ${s.opereta.version}${s.opereta.slots ? ` · ${s.opereta.slots} slots` : ""}` : ""}
        </div>
        {s.models.slice(0, 12).map((m) => (
          <div key={m.id} className="sub">
            {m.id}
            {m.context ? ` · ${compactNumber(m.context)} ctx` : ""}
            {m.details ? ` · ${m.details}` : ""}
          </div>
        ))}
        {s.models.length === 0 ? <div className="sub">(no models listed)</div> : null}
      </div>
    )
  }
  return (
    <div className="check bad" role="alert">
      {check.url}: {check.problem?.message ?? "Not usable."}
    </div>
  )
}

export function ModelsView({ dir }: { dir: string }) {
  const project = useStore((s) => s.projects[dir])
  const [local, setLocal] = useState<LocalInfo | undefined>()
  const [hosts, setHosts] = useState<RemoteHost[]>([])
  const [checks, setChecks] = useState<Record<string, Check | "running">>({})
  const [toolchecks, setToolchecks] = useState<Record<string, string>>({})
  const [scan, setScan] = useState<{ running: boolean; found: Check[]; needKey: Check[]; tried?: number; error?: string } | undefined>()
  const [pulls, setPulls] = useState<Record<string, Pull>>({})
  const [pullName, setPullName] = useState("")
  const [form, setForm] = useState({ name: "", url: "", key: "", ca: "" })
  const [formError, setFormError] = useState("")
  const [formCheck, setFormCheck] = useState<Check | undefined>()

  const reloadLocal = () => request<LocalInfo>(dir, "GET", "/local").then(setLocal, () => {})
  const reloadHosts = () => request<RemoteHost[]>(dir, "GET", "/remote").then(setHosts, () => {})

  useEffect(() => {
    void reloadLocal()
    void reloadHosts()
    return window.deberopa.onEvent(({ dir: d, event }) => {
      if (d !== dir || event.type !== "local.pull") return
      const p = event.properties as Pull
      setPulls((prev) => ({ ...prev, [`${p.provider}/${p.model}`]: p }))
      if (p.done && !p.error) void refreshProject(dir)
    })
  }, [dir])

  const check = async (id: string) => {
    setChecks((c) => ({ ...c, [id]: "running" }))
    try {
      const result = await request<Check>(dir, "POST", "/remote/check", { id })
      setChecks((c) => ({ ...c, [id]: result }))
    } catch (err) {
      setChecks((c) => ({ ...c, [id]: { ok: false, url: id, problem: { code: "error", message: errText(err) } } }))
    }
  }

  const toolcheck = async (model: string) => {
    setToolchecks((t) => ({ ...t, [model]: "Asking the model to call a tool…" }))
    try {
      const r = await request<{ status: string; detail?: string }>(dir, "POST", "/local/toolcheck", { model })
      const words: Record<string, string> = {
        ok: "Tool calls work: the model answered with a structured call.",
        recovered: "Tool calls work, with help: the model wrote the call as text and Deberopa recovered it.",
        failed: `Tool calls do not work${r.detail ? `: ${r.detail}` : ""}. The agent cannot read or edit files with this model.`,
        unauthorized: "The server needs an API key.",
        error: `The check could not run: ${r.detail ?? "unknown error"}.`,
      }
      setToolchecks((t) => ({ ...t, [model]: words[r.status] ?? r.status }))
    } catch (err) {
      setToolchecks((t) => ({ ...t, [model]: errText(err) }))
    }
  }

  const doScan = async () => {
    setScan({ running: true, found: [], needKey: [] })
    try {
      const r = await request<{ found: Check[]; needKey: Check[]; tried: number }>(dir, "POST", "/remote/scan", {})
      setScan({ running: false, found: r.found, needKey: r.needKey, tried: r.tried })
    } catch (err) {
      setScan({ running: false, found: [], needKey: [], error: errText(err) })
    }
  }

  const saveHost = async (input: { name: string; url: string; key?: string; ca?: string }) => {
    setFormError("")
    try {
      const r = await request<{ host: RemoteHost; check: Check }>(dir, "POST", "/remote", {
        name: input.name,
        url: input.url,
        ...(input.key ? { key: input.key } : {}),
        ...(input.ca ? { ca: input.ca } : {}),
      })
      setFormCheck(r.check)
      setForm({ name: "", url: "", key: "", ca: "" })
      await reloadHosts()
      await refreshProject(dir)
    } catch (err) {
      setFormError(errText(err))
    }
  }

  const removeHost = async (id: string) => {
    await request(dir, "DELETE", `/remote/${encodeURIComponent(id)}`).catch(() => {})
    await reloadHosts()
    await refreshProject(dir)
  }

  const ollama = local?.servers.find((s) => s.id === "ollama")
  const remoteModels = project?.models.filter((m) => hosts.some((h) => h.id === m.provider)) ?? []

  return (
    <div className="models" data-testid="models">
      <h2>Models and servers</h2>

      <section>
        <div className="head">
          <h3>This computer</h3>
          <button onClick={() => void reloadLocal()}>Rescan</button>
        </div>
        {local?.servers.map((s) => (
          <div key={s.id} className="srv">
            <span className="mark">●</span>
            <span className="name">{s.name}</span>
            <span className="sub">
              {s.opereta ? `Opereta ${s.opereta.version}${s.opereta.slots ? ` · ${s.opereta.slots} slots` : ""} · ` : ""}
              {s.models.length} model{s.models.length === 1 ? "" : "s"}
            </span>
          </div>
        ))}
        {local?.failures.map((f) => (
          <div key={f.baseURL} className="srv">
            <span className="mark">!</span>
            <span className="name">{f.id}</span>
            <span className="sub">needs an API key (HTTP {f.status})</span>
          </div>
        ))}
        {local && local.servers.length === 0 ? (
          <div>
            <div className="sub">No local model server answered. Start one and press Rescan:</div>
            {local.expected.map((e) => (
              <div key={e.kind} className="hint">
                <strong>
                  {e.name} (port {e.port})
                </strong>{" "}
                — {e.hint}
              </div>
            ))}
          </div>
        ) : null}
        {ollama ? (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault()
              const model = pullName.trim()
              if (model) void request(dir, "POST", "/local/pull", { provider: "ollama", model }).catch((err) => setPulls((p) => ({ ...p, [model]: { provider: "ollama", model, status: "", done: true, error: errText(err) } })))
            }}
          >
            <input type="text" value={pullName} placeholder="Download a model, e.g. qwen3:8b" aria-label="Model to download" onChange={(e) => setPullName(e.target.value)} />
            <button type="submit">Download</button>
          </form>
        ) : null}
        {Object.values(pulls).map((p) => (
          <div key={`${p.provider}/${p.model}`} className="srv">
            <span className="mark">{p.error ? "✕" : p.done ? "●" : "◐"}</span>
            <span className="name">{p.model}</span>
            <span className="sub">{p.error ? `failed: ${p.error}` : p.done ? "ready — pick it in the model list" : `${p.status}${p.total && p.completed !== undefined ? ` ${Math.round((p.completed / p.total) * 100)}%` : ""}`}</span>
          </div>
        ))}
      </section>

      <section>
        <div className="head">
          <h3>Other computers</h3>
          <button onClick={() => void doScan()} disabled={scan?.running} data-testid="scan">
            {scan?.running ? "Looking…" : "Look on this network"}
          </button>
        </div>
        <p className="sub">
          Inference runs on the other computer; your files, tools and sessions stay here. Looking on the network happens only when you press the button and sends no key.
        </p>
        {hosts.map((h) => {
          const c = checks[h.id]
          return (
            <div key={h.id} className="host">
              <div className="srv">
                <span className="mark">●</span>
                <span className="name">{h.name}</span>
                <span className="sub">
                  {h.url} · {h.protocol}
                  {h.hasKey ? " · key" : ""}
                  {h.hasCA ? " · own CA" : ""}
                </span>
                <span className="spacer" />
                <button onClick={() => void check(h.id)}>Check</button>
                <button onClick={() => void removeHost(h.id)}>Remove</button>
              </div>
              {c === "running" ? <div className="sub">Checking…</div> : c ? <CheckLines check={c} /> : null}
            </div>
          )
        })}
        {hosts.length === 0 ? <div className="sub">No saved computers yet.</div> : null}

        {scan?.error ? <div className="error">{scan.error}</div> : null}
        {scan && !scan.running ? (
          <div className="scan">
            {scan.found.map((c) => (
              <div key={c.url} className="srv">
                <span className="mark">●</span>
                <span className="name">{c.server?.name}</span>
                <span className="sub">
                  {c.url} · {c.server?.models.length ?? 0} model(s)
                </span>
                <span className="spacer" />
                <button onClick={() => setForm({ name: "", url: c.url.replace(/^https?:\/\//, ""), key: "", ca: "" })}>Use</button>
              </div>
            ))}
            {scan.needKey.map((c) => (
              <div key={c.url} className="srv">
                <span className="mark">!</span>
                <span className="name">{c.url}</span>
                <span className="sub">answers, needs an API key</span>
                <span className="spacer" />
                <button onClick={() => setForm({ name: "", url: c.url.replace(/^https?:\/\//, ""), key: "", ca: "" })}>Use</button>
              </div>
            ))}
            {scan.found.length === 0 && scan.needKey.length === 0 ? (
              <div className="hint">
                Nothing found ({scan.tried} addresses). The server must listen on the network, not only on localhost (Ollama: OLLAMA_HOST=0.0.0.0; llama-server: --host 0.0.0.0), and its port must be open in the firewall. You can still add it by address below.
              </div>
            ) : null}
          </div>
        ) : null}

        <form
          className="add"
          onSubmit={(e) => {
            e.preventDefault()
            if (form.name.trim() && form.url.trim()) void saveHost(form)
          }}
        >
          <strong>Add a computer</strong>
          <input type="text" value={form.name} placeholder="Name, e.g. gpu-box" aria-label="Name" onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input type="text" value={form.url} placeholder="Address, e.g. 192.168.0.20:11434" aria-label="Address" onChange={(e) => setForm({ ...form, url: e.target.value })} />
          <input type="password" value={form.key} placeholder="API key (if the server needs one)" aria-label="API key" autoComplete="off" onChange={(e) => setForm({ ...form, key: e.target.value })} />
          <input type="text" value={form.ca} placeholder="CA certificate file (HTTPS with your own CA)" aria-label="CA file" onChange={(e) => setForm({ ...form, ca: e.target.value })} />
          <div className="row">
            <button type="submit" className="primary" data-testid="save-host">
              Save
            </button>
          </div>
          {formError ? <div className="error">{formError}</div> : null}
          {formCheck ? <CheckLines check={formCheck} /> : null}
        </form>
      </section>

      <section>
        <h3>Models</h3>
        {project?.models.length === 0 ? <div className="sub">No model is available yet. Start a local server or add a computer above, or add an API key.</div> : null}
        {project?.models.map((m) => (
          <div key={m.value} className="host">
            <div className="srv">
              <span className="mark">{m.local ? "●" : "○"}</span>
              <span className="name">{m.providerName} · {m.name}</span>
              <span className="sub">
                {m.local ? (remoteModels.includes(m) ? "other computer" : "this computer") : "hosted"}
                {m.context ? ` · ${compactNumber(m.context)} ctx` : ""}
                {m.mode?.compactPrompt ? " · compact prompt" : ""}
              </span>
              <span className="spacer" />
              <button onClick={() => void toolcheck(m.value)}>Check tool calls</button>
            </div>
            {toolchecks[m.value] ? <div className="sub">{toolchecks[m.value]}</div> : null}
          </div>
        ))}
      </section>
    </div>
  )
}
