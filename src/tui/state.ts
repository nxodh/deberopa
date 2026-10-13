import { subscribe as busSubscribe } from "../util/bus"
import { pendingPermissions, type PendingPermission } from "../permission/permission"
import { getSession } from "../session/store"
import { visibleMessages } from "../session/revert"
import { isBusy } from "../session/prompt"
import { getTodos, type TodoItem } from "../tool/todo"
import { mcpStatus } from "../mcp"
import { gitStatus, isIgnored, type GitStatus } from "../git/git"
import { snapshotStatus, type SnapshotStatus } from "../snapshot/snapshot"
import { project } from "../project"
import type { Message, SessionInfo } from "../session/message"

export interface Toast {
  text: string
  kind: "info" | "error"
  until: number
}

export type RunStatus = { type: "idle" } | { type: "busy"; since: number } | { type: "retry"; attempt: number; message: string; next: number; since: number }

/**
 * Everything the UI shows, kept outside React. The session layer mutates messages in place
 * while streaming, so components read from here and re-render when `version` changes;
 * notifications are coalesced so a burst of tokens costs one frame, not hundreds.
 */
class AppState {
  version = 0
  /** Bumped whenever the scrollback must be redrawn from scratch (new session, undo). */
  epoch = 0
  session?: SessionInfo
  messages: Message[] = []
  status: RunStatus = { type: "idle" }
  permissions: PendingPermission[] = []
  todos: TodoItem[] = []
  toast?: Toast
  agent = "build"
  model?: { providerID: string; modelID: string }
  details = false
  theme = "mono"
  mcp: ReturnType<typeof mcpStatus> = []
  git?: GitStatus
  /** Whether /undo can restore files in this project (checked lazily on the first edit). */
  undoSupport?: SnapshotStatus
  private warnedIgnored = new Set<string>()
  private warnedNoSnapshot = false
  private gitTimer: ReturnType<typeof setTimeout> | undefined
  private gitBusy = false

  private listeners = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private unsubscribers: (() => void)[] = []

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot = () => this.version

  /** Schedule a re-render. Streaming updates are batched into ~30 frames a second. */
  notify(immediate = false) {
    if (immediate) {
      if (this.timer) clearTimeout(this.timer)
      this.timer = undefined
      this.emit()
      return
    }
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.emit()
    }, 33)
  }

  private emit() {
    this.version++
    for (const listener of [...this.listeners]) listener()
  }

  showToast(text: string, kind: Toast["kind"] = "info", ms = 4000) {
    this.toast = { text, kind, until: Date.now() + ms }
    this.notify(true)
    const timer = setTimeout(() => {
      if (this.toast && this.toast.until <= Date.now()) {
        this.toast = undefined
        this.notify(true)
      }
    }, ms + 20)
    timer.unref?.()
  }

  /** Point the UI at a session (or at none: the home screen). */
  async open(sessionID: string | undefined) {
    this.session = sessionID ? await getSession(sessionID) : undefined
    await this.reload()
    this.status = sessionID && isBusy(sessionID) ? { type: "busy", since: Date.now() } : { type: "idle" }
    this.todos = sessionID ? await getTodos(sessionID).catch(() => []) : []
    this.epoch++
    this.notify(true)
  }

  async reload() {
    this.messages = this.session ? [...(await visibleMessages(this.session.id))] : []
  }

  start() {
    const current = (sessionID: string) => this.session?.id === sessionID
    const on = <T>(type: string, fn: (properties: T) => void) => this.unsubscribers.push(busSubscribe<T>(type, (event) => fn(event.properties)))

    on<{ message: Message }>("message.updated", ({ message }) => {
      if (!current(message.sessionID)) return
      // New messages are appended by the store after our copy was taken.
      if (!this.messages.some((m) => m.id === message.id)) this.messages.push(message)
      this.notify()
    })
    on<{ sessionID: string }>("message.part.updated", ({ sessionID }) => {
      if (current(sessionID)) this.notify()
    })
    on<{ sessionID: string; messageID: string }>("message.removed", ({ sessionID, messageID }) => {
      if (!current(sessionID)) return
      this.messages = this.messages.filter((m) => m.id !== messageID)
      this.notify()
    })
    on<{ info: SessionInfo }>("session.updated", ({ info }) => {
      if (!current(info.id)) return
      this.session = info
      this.notify()
    })
    on<{ sessionID: string; status: { type: "idle" } | { type: "busy" } | { type: "retry"; attempt: number; message: string; next: number } }>(
      "session.status",
      ({ sessionID, status }) => {
        if (!current(sessionID)) return
        const since = this.status.type === "idle" ? Date.now() : this.status.since
        this.status = status.type === "idle" ? { type: "idle" } : { ...status, since }
        this.notify(true)
      },
    )
    on<{ sessionID: string }>("session.reverted", ({ sessionID }) => {
      if (!current(sessionID)) return
      void this.open(sessionID)
    })
    on<{ sessionID: string; todos: TodoItem[] }>("todo.updated", ({ sessionID, todos }) => {
      if (!current(sessionID)) return
      this.todos = todos
      this.notify()
    })
    const permissions = () => {
      this.permissions = pendingPermissions()
      this.notify(true)
    }
    on("permission.asked", permissions)
    on("permission.replied", permissions)
    on<{ file: string }>("file.edited", ({ file }) => void this.onFileEdited(file))
    on("mcp.updated", () => {
      this.mcp = mcpStatus()
      this.notify()
    })
  }

  /** Re-read branch and working-tree state. Coalesced: bursts of edits cost one `git status`. */
  refreshGit(delayMs = 400) {
    if (this.gitTimer) return
    this.gitTimer = setTimeout(async () => {
      this.gitTimer = undefined
      if (this.gitBusy) return
      this.gitBusy = true
      try {
        const next = await gitStatus(project().worktree)
        if (JSON.stringify(next) !== JSON.stringify(this.git)) {
          this.git = next
          this.notify(true)
        }
      } finally {
        this.gitBusy = false
      }
    }, delayMs)
    this.gitTimer.unref?.()
  }

  /** Tell the user, once, about edits `/undo` will not be able to restore. */
  private async onFileEdited(file: string) {
    this.refreshGit()
    this.undoSupport ??= await snapshotStatus()
    if (!this.undoSupport.available) {
      if (!this.warnedNoSnapshot) {
        this.warnedNoSnapshot = true
        this.showToast(`/undo will not restore files here: ${this.undoSupport.reason}.`, "info", 8000)
      }
      return
    }
    if (this.warnedIgnored.has(file)) return
    if (await isIgnored(project().worktree, file).catch(() => false)) {
      this.warnedIgnored.add(file)
      const rel = file.startsWith(project().worktree) ? file.slice(project().worktree.length + 1) : file
      this.showToast(`${rel} is git-ignored, so /undo cannot restore it.`, "info", 8000)
    }
  }

  stop() {
    for (const off of this.unsubscribers.splice(0)) off()
    if (this.timer) clearTimeout(this.timer)
    if (this.gitTimer) clearTimeout(this.gitTimer)
  }
}

export const app = new AppState()
export type { AppState }
