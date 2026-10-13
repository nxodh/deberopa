import fs from "node:fs/promises"
import path from "node:path"
import { Paths, VERSION } from "../global"
import { project } from "../project"
import { createID } from "../util/id"
import { publish } from "../util/bus"
import { readJSON, writeJSON } from "../util/fs"
import type { Message, Part, SessionInfo } from "./message"

/**
 * Sessions live on disk as plain JSON:
 *   storage/session/<projectID>/<sessionID>/info.json
 *   storage/session/<projectID>/<sessionID>/message/<messageID>.json
 * Message ids ascend with time, so a sorted directory listing is the conversation.
 */
const root = () => path.join(Paths.storage, "session")
const sessionDir = (projectID: string, sessionID: string) => path.join(root(), projectID, sessionID)

const infoCache = new Map<string, SessionInfo>()
const messageCache = new Map<string, Message[]>()
const dirty = new Map<string, Message>()
let flushTimer: ReturnType<typeof setTimeout> | undefined

async function locate(sessionID: string): Promise<string | undefined> {
  const cached = infoCache.get(sessionID)
  if (cached) return sessionDir(cached.projectID, sessionID)
  const here = sessionDir(project().id, sessionID)
  if (await readJSON(path.join(here, "info.json"))) return here
  // Sessions can be addressed from another directory (export, server); search all projects.
  for (const projectID of await fs.readdir(root()).catch(() => [] as string[])) {
    const dir = sessionDir(projectID, sessionID)
    if (await readJSON(path.join(dir, "info.json"))) return dir
  }
  return undefined
}

export async function createSession(input: { parentID?: string; title?: string; directory?: string } = {}): Promise<SessionInfo> {
  const now = Date.now()
  const info: SessionInfo = {
    id: createID("session"),
    projectID: project().id,
    directory: input.directory ?? project().directory,
    parentID: input.parentID,
    title: input.title ?? defaultTitle(!!input.parentID),
    version: VERSION,
    time: { created: now, updated: now },
  }
  infoCache.set(info.id, info)
  messageCache.set(info.id, [])
  await writeJSON(path.join(sessionDir(info.projectID, info.id), "info.json"), info)
  publish("session.created", { info })
  return info
}

export function defaultTitle(child = false) {
  return (child ? "Child session - " : "New session - ") + new Date().toISOString()
}

export function isDefaultTitle(title: string) {
  return /^(New session|Child session) - \d{4}-\d{2}-\d{2}T/.test(title)
}

export async function getSession(sessionID: string): Promise<SessionInfo | undefined> {
  const cached = infoCache.get(sessionID)
  if (cached) return cached
  const dir = await locate(sessionID)
  if (!dir) return undefined
  const info = await readJSON<SessionInfo>(path.join(dir, "info.json"))
  if (info) infoCache.set(sessionID, info)
  return info
}

export async function requireSession(sessionID: string): Promise<SessionInfo> {
  const info = await getSession(sessionID)
  if (!info) throw new Error(`Session not found: ${sessionID}`)
  return info
}

export async function updateSession(sessionID: string, mutate: (info: SessionInfo) => void): Promise<SessionInfo> {
  const info = await requireSession(sessionID)
  mutate(info)
  info.time.updated = Date.now()
  await writeJSON(path.join(sessionDir(info.projectID, info.id), "info.json"), info)
  publish("session.updated", { info })
  return info
}

/** Sessions of the current project (or all projects), most recently updated first. */
export async function listSessions(opts: { all?: boolean; includeChildren?: boolean } = {}): Promise<SessionInfo[]> {
  const projects = opts.all ? await fs.readdir(root()).catch(() => [] as string[]) : [project().id]
  const result: SessionInfo[] = []
  for (const projectID of projects) {
    const ids = await fs.readdir(path.join(root(), projectID)).catch(() => [] as string[])
    await Promise.all(
      ids.map(async (id) => {
        const info = infoCache.get(id) ?? (await readJSON<SessionInfo>(path.join(sessionDir(projectID, id), "info.json")))
        if (!info) return
        if (!infoCache.has(id)) infoCache.set(id, info)
        if (info.parentID && !opts.includeChildren) return
        result.push(info)
      }),
    )
  }
  return result.sort((a, b) => b.time.updated - a.time.updated)
}

export async function childSessions(parentID: string): Promise<SessionInfo[]> {
  return (await listSessions({ includeChildren: true })).filter((s) => s.parentID === parentID)
}

export async function deleteSession(sessionID: string) {
  const info = await getSession(sessionID)
  if (!info) return
  for (const child of await childSessions(sessionID)) await deleteSession(child.id)
  await fs.rm(sessionDir(info.projectID, sessionID), { recursive: true, force: true })
  await fs.rm(path.join(Paths.storage, "todo", `${sessionID}.json`), { force: true })
  infoCache.delete(sessionID)
  messageCache.delete(sessionID)
  publish("session.deleted", { info })
}

/** All messages of a session, oldest first. The returned array is the live in-memory copy. */
export async function getMessages(sessionID: string): Promise<Message[]> {
  const cached = messageCache.get(sessionID)
  if (cached) return cached
  const dir = await locate(sessionID)
  const messages: Message[] = []
  if (dir) {
    const files = (await fs.readdir(path.join(dir, "message")).catch(() => [] as string[])).filter((f) => f.endsWith(".json")).sort()
    for (const file of files) {
      const message = await readJSON<Message>(path.join(dir, "message", file))
      if (message) messages.push(message)
    }
  }
  messageCache.set(sessionID, messages)
  return messages
}

async function persist(message: Message) {
  const info = await getSession(message.sessionID)
  if (!info) return
  await writeJSON(path.join(sessionDir(info.projectID, info.id), "message", `${message.id}.json`), message)
}

export async function flush() {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = undefined
  const pending = [...dirty.values()]
  dirty.clear()
  await Promise.all(pending.map((m) => persist(m).catch(() => {})))
}

function scheduleFlush() {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = undefined
    void flush()
  }, 400)
  // never keep the process alive just to write a debounce
  ;(flushTimer as any).unref?.()
}

export async function addMessage(message: Message) {
  const list = await getMessages(message.sessionID)
  list.push(message)
  await persist(message)
  publish("message.updated", { message })
}

/**
 * Announce a change to a message. Streaming deltas arrive many times a second, so disk
 * writes are debounced; pass `now` for state that must survive a crash (finished steps).
 */
export async function touchMessage(message: Message, opts: { part?: Part; delta?: string; now?: boolean } = {}) {
  if (opts.part) publish("message.part.updated", { sessionID: message.sessionID, messageID: message.id, part: opts.part, delta: opts.delta })
  else publish("message.updated", { message })
  if (opts.now) {
    dirty.delete(message.id)
    await persist(message)
  } else {
    dirty.set(message.id, message)
    scheduleFlush()
  }
}

export async function removeMessage(sessionID: string, messageID: string) {
  const list = await getMessages(sessionID)
  const index = list.findIndex((m) => m.id === messageID)
  if (index === -1) return
  list.splice(index, 1)
  dirty.delete(messageID)
  const info = await getSession(sessionID)
  if (info) await fs.rm(path.join(sessionDir(info.projectID, sessionID), "message", `${messageID}.json`), { force: true })
  publish("message.removed", { sessionID, messageID })
}

/** Import a session exported with `vedecaps export`. */
export async function importSession(data: { info: SessionInfo; messages: Message[] }): Promise<SessionInfo> {
  const info: SessionInfo = { ...data.info, projectID: project().id }
  infoCache.set(info.id, info)
  messageCache.set(info.id, data.messages)
  await writeJSON(path.join(sessionDir(info.projectID, info.id), "info.json"), info)
  for (const message of data.messages) await persist(message)
  return info
}
