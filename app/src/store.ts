import { useSyncExternalStore } from "react"
import { request } from "./bridge"
import { applyEvent, newConv, type Conv } from "./conv"

export interface ModelChoice {
  value: string
  label: string
  name: string
  providerName: string
  local: boolean
  provider: string
  protocol: string
  context: number
  mode: { compactPrompt?: boolean; compactReason?: string; textTools?: boolean } | null
}
export interface SessionRow {
  id: string
  title: string
  updated: number
}
export interface ProjectState {
  dir: string
  name: string
  status: "ready" | "error"
  error?: string
  sessions: SessionRow[]
  agents: { name: string; description: string }[]
  models: ModelChoice[]
  defaultModel?: string
  commands: { name: string; description?: string }[]
  trust?: { trusted: boolean; blocked: string[] }
}
export type Tab = { id: string; kind: "session"; dir: string; sessionID: string } | { id: string; kind: "models"; dir: string }
export interface AppState {
  ready: boolean
  version: string
  platform: string
  recents: string[]
  projects: Record<string, ProjectState>
  order: string[]
  convs: Record<string, Conv>
  tabs: Tab[]
  active?: string
  selection: Record<string, { model?: string; agent?: string }>
  notice?: string
}

let state: AppState = { ready: false, version: "", platform: "", recents: [], projects: {}, order: [], convs: {}, tabs: [], selection: {} }
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
const set = (patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) => {
  state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }
  emit()
}
export const getState = () => state
export function useStore<T>(select: (s: AppState) => T): T {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => select(state),
  )
}

export const convKey = (dir: string, id: string) => `${dir}\u0000${id}`
export const sessionTabID = (dir: string, id: string) => `session:${convKey(dir, id)}`
export const modelsTabID = (dir: string) => `models:${dir}`

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))
export const notify = (notice?: string) => set({ notice })

// ---- project data -------------------------------------------------------------------------------------
async function loadProject(dir: string, name: string): Promise<ProjectState> {
  try {
    const [agents, providers, sessions, commands, trust] = await Promise.all([
      request<any[]>(dir, "GET", "/agent"),
      request<any>(dir, "GET", "/provider"),
      request<any[]>(dir, "GET", "/session"),
      request<any[]>(dir, "GET", "/command").catch(() => []),
      request<any>(dir, "GET", "/trust").catch(() => undefined),
    ])
    const models: ModelChoice[] = (providers.providers as any[])
      .filter((p) => p.connected)
      // models on your own computers (this one or another) come first: that is what this app is for
      .sort((a, b) => Number(!!b.local) - Number(!!a.local))
      .flatMap((p) =>
        Object.values<any>(p.models).map((m) => ({
          value: `${p.id}/${m.id}`,
          label: `${p.local ? "● " : ""}${p.name} · ${m.name}`,
          name: m.name as string,
          providerName: p.name as string,
          local: !!p.local,
          provider: p.id as string,
          protocol: p.protocol as string,
          context: m.limit?.context ?? 0,
          mode: m.mode ?? null,
        })),
      )
    return {
      dir,
      name,
      status: "ready",
      sessions: sessions.slice().sort((a, b) => b.time.updated - a.time.updated).map((s) => ({ id: s.id, title: s.title, updated: s.time.updated })),
      agents: agents.filter((a) => a.mode !== "subagent" && !a.hidden).map((a) => ({ name: a.name, description: a.description ?? "" })),
      models,
      defaultModel: providers.default ? `${providers.default.providerID}/${providers.default.modelID}` : undefined,
      commands: commands.map((c) => ({ name: c.name, description: c.description })),
      trust: trust ? { trusted: !!trust.trusted, blocked: trust.blocked ?? [] } : undefined,
    }
  } catch (err) {
    return { dir, name, status: "error", error: errText(err), sessions: [], agents: [], models: [], commands: [] }
  }
}

export async function refreshProject(dir: string) {
  const current = state.projects[dir]
  if (!current) return
  const next = await loadProject(dir, current.name)
  set((s) => ({ projects: { ...s.projects, [dir]: next } }))
}

let sessionRefresh: Record<string, ReturnType<typeof setTimeout>> = {}
function refreshSessionsSoon(dir: string) {
  clearTimeout(sessionRefresh[dir])
  sessionRefresh[dir] = setTimeout(async () => {
    try {
      const sessions = await request<any[]>(dir, "GET", "/session")
      set((s) => {
        const project = s.projects[dir]
        if (!project) return {}
        const rows = sessions.slice().sort((a, b) => b.time.updated - a.time.updated).map((x) => ({ id: x.id, title: x.title, updated: x.time.updated }))
        return { projects: { ...s.projects, [dir]: { ...project, sessions: rows } } }
      })
    } catch {}
  }, 250)
}

// ---- startup and events -----------------------------------------------------------------------------
let started = false
export async function init() {
  if (started) return
  started = true
  const info = await window.deberopa.info()
  set({ ready: true, version: info.version, platform: info.platform, recents: info.recents })
  // test mode: the smoke test names a folder to open without a dialog
  if (info.testProject) void openProject(info.testProject)
  window.deberopa.onEvent(({ dir, event }) => {
    if (event.type.startsWith("session.") && ["session.created", "session.updated", "session.deleted"].includes(event.type)) refreshSessionsSoon(dir)
    const prefix = `${dir}\u0000`
    for (const [key, conv] of Object.entries(state.convs)) {
      if (!key.startsWith(prefix)) continue
      const next = applyEvent(conv, event)
      if (next === "reload") void loadConv(dir, conv.sessionID)
      else if (next) set((s) => ({ convs: { ...s.convs, [key]: next } }))
    }
  })
  window.deberopa.onProjectExit(({ dir, code }) => {
    set((s) => {
      const project = s.projects[dir]
      if (!project) return {}
      return { projects: { ...s.projects, [dir]: { ...project, status: "error", error: `The agent for this project stopped (exit ${code}).` } } }
    })
  })
}

export async function openProject(dir?: string) {
  const res = await window.deberopa.openProject(dir)
  if (!res.ok) {
    if (!res.canceled) notify(res.error)
    return
  }
  const opened = res.dir!
  const project = await loadProject(opened, res.name!)
  set((s) => ({
    projects: { ...s.projects, [opened]: project },
    order: s.order.includes(opened) ? s.order : [...s.order, opened],
    recents: [opened, ...s.recents.filter((d) => d !== opened)].slice(0, 12),
    notice: undefined,
  }))
  const latest = project.sessions[0]
  if (latest) await openSession(opened, latest.id)
  else await newSession(opened)
}

export async function closeProject(dir: string) {
  await window.deberopa.closeProject(dir)
  set((s) => {
    const { [dir]: _gone, ...projects } = s.projects
    const tabs = s.tabs.filter((t) => t.dir !== dir)
    const convs = Object.fromEntries(Object.entries(s.convs).filter(([k]) => !k.startsWith(`${dir}\u0000`)))
    const active = s.active && tabs.some((t) => t.id === s.active) ? s.active : tabs[tabs.length - 1]?.id
    return { projects, order: s.order.filter((d) => d !== dir), tabs, convs, active }
  })
}

// ---- sessions and tabs ------------------------------------------------------------------------------
export async function loadConv(dir: string, id: string) {
  const key = convKey(dir, id)
  try {
    const [session, messages, permissions] = await Promise.all([
      request<any>(dir, "GET", `/session/${encodeURIComponent(id)}`),
      request<any[]>(dir, "GET", `/session/${encodeURIComponent(id)}/message`),
      request<any[]>(dir, "GET", "/permission").catch(() => []),
    ])
    set((s) => {
      const base = s.convs[key] ?? newConv(id)
      return {
        convs: {
          ...s.convs,
          [key]: {
            ...base,
            title: session.title,
            // the message route returns `{ info, parts }` rows; flatten them to our message shape
            messages: messages.map((m: any) => (m.info ? { ...m.info, parts: m.parts } : m)),
            permissions: permissions.filter((p: any) => p.sessionID === id),
            loaded: true,
          },
        },
      }
    })
  } catch (err) {
    set((s) => ({ convs: { ...s.convs, [key]: { ...(s.convs[key] ?? newConv(id)), loaded: true, error: { message: errText(err) } } } }))
  }
}

export async function openSession(dir: string, id: string) {
  const tabID = sessionTabID(dir, id)
  set((s) => ({
    tabs: s.tabs.some((t) => t.id === tabID) ? s.tabs : [...s.tabs, { id: tabID, kind: "session", dir, sessionID: id }],
    active: tabID,
    convs: s.convs[convKey(dir, id)] ? s.convs : { ...s.convs, [convKey(dir, id)]: newConv(id, s.projects[dir]?.sessions.find((x) => x.id === id)?.title ?? "") },
  }))
  await loadConv(dir, id)
}

export async function newSession(dir: string) {
  try {
    const session = await request<any>(dir, "POST", "/session", {})
    await refreshProject(dir)
    await openSession(dir, session.id)
  } catch (err) {
    notify(errText(err))
  }
}

export function openModels(dir: string) {
  const id = modelsTabID(dir)
  set((s) => ({ tabs: s.tabs.some((t) => t.id === id) ? s.tabs : [...s.tabs, { id, kind: "models", dir }], active: id }))
}

export function setActive(id: string) {
  set({ active: id })
}

export function closeTab(id: string) {
  set((s) => {
    const index = s.tabs.findIndex((t) => t.id === id)
    if (index === -1) return {}
    const tabs = s.tabs.filter((t) => t.id !== id)
    const active = s.active === id ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? undefined) : s.active
    return { tabs, active }
  })
}

export async function deleteSession(dir: string, id: string) {
  try {
    await request(dir, "DELETE", `/session/${encodeURIComponent(id)}`)
    closeTab(sessionTabID(dir, id))
    await refreshProject(dir)
  } catch (err) {
    notify(errText(err))
  }
}

export function select(tabID: string, patch: { model?: string; agent?: string }) {
  set((s) => ({ selection: { ...s.selection, [tabID]: { ...s.selection[tabID], ...patch } } }))
}

// ---- talking to the agent -----------------------------------------------------------------------------
export async function send(tab: Extract<Tab, { kind: "session" }>, text: string) {
  const { dir, sessionID } = tab
  const key = convKey(dir, sessionID)
  const project = state.projects[dir]
  const chosen: Record<string, string> = {}
  const sel = state.selection[tab.id] ?? {}
  if (sel.agent && project?.agents.some((a) => a.name === sel.agent)) chosen.agent = sel.agent
  if (sel.model && project?.models.some((m) => m.value === sel.model)) chosen.model = sel.model
  set((s) => ({ convs: { ...s.convs, [key]: { ...s.convs[key]!, busy: true, error: undefined } } }))
  try {
    const slash = /^\/(\S+)\s*([\s\S]*)$/.exec(text)
    const id = encodeURIComponent(sessionID)
    if (slash && project?.commands.some((c) => c.name === slash[1])) await request(dir, "POST", `/session/${id}/command`, { name: slash[1], arguments: slash[2], ...chosen })
    else if (text.startsWith("!") && text.slice(1).trim() !== "") await request(dir, "POST", `/session/${id}/shell`, { command: text.slice(1).trim() })
    else await request(dir, "POST", `/session/${id}/prompt_async`, { text, ...chosen })
  } catch (err) {
    set((s) => ({ convs: { ...s.convs, [key]: { ...s.convs[key]!, busy: false, error: { message: errText(err) } } } }))
  }
}

export const abort = (dir: string, id: string) => request(dir, "POST", `/session/${encodeURIComponent(id)}/abort`, {}).catch(() => {})
export const undoMessage = (dir: string, id: string, messageID: string) => request(dir, "POST", `/session/${encodeURIComponent(id)}/revert`, { messageID }).catch((e) => notify(errText(e)))
export const replyPermission = (dir: string, permissionID: string, reply: "once" | "always" | "reject") =>
  request(dir, "POST", `/permission/${encodeURIComponent(permissionID)}`, { reply }).catch((e) => notify(errText(e)))
export const compactSession = (dir: string, id: string) => request(dir, "POST", `/session/${encodeURIComponent(id)}/compact`, {}).catch((e) => notify(errText(e)))
export const grantTrust = async (dir: string) => {
  await request(dir, "POST", "/trust", {}).catch((e) => notify(errText(e)))
  await refreshProject(dir)
}
