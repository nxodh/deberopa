// Conversation state for one session, kept in step with the server's event stream.
export interface Part {
  id: string
  type: string
  [key: string]: any
}
export interface Message {
  id: string
  role: "user" | "assistant"
  parts?: Part[]
  tokens?: { input: number; output: number; cacheRead?: number }
  timings?: { generationMs?: number }
  time?: { created: number; completed?: number }
  error?: { message: string }
  [key: string]: any
}
export interface Permission {
  id: string
  sessionID: string
  title?: string
  tool?: string
  [key: string]: any
}
export interface Conv {
  sessionID: string
  title: string
  busy: boolean
  retry?: any
  messages: Message[]
  permissions: Permission[]
  todos: { content: string; status: string }[]
  error?: { message: string }
  loaded: boolean
}

export const newConv = (sessionID: string, title = ""): Conv => ({ sessionID, title, busy: false, messages: [], permissions: [], todos: [], loaded: false })

/** Applies one server event to `conv` (a copy is returned when it changed). "reload" means refetch the history. */
export function applyEvent(conv: Conv, event: { type: string; properties?: any }): Conv | "reload" | undefined {
  const p = event.properties ?? {}
  const id = conv.sessionID
  switch (event.type) {
    case "message.updated": {
      if (!p.message || p.message.sessionID !== id) return
      const messages = conv.messages.slice()
      const i = messages.findIndex((m) => m.id === p.message.id)
      if (i === -1) messages.push(p.message)
      else messages[i] = { ...messages[i]!, ...p.message, parts: p.message.parts ?? messages[i]!.parts }
      return { ...conv, messages }
    }
    case "message.part.updated": {
      if (p.sessionID !== id || !p.part) return
      const i = conv.messages.findIndex((m) => m.id === p.messageID)
      if (i === -1) return
      const messages = conv.messages.slice()
      const message = messages[i]!
      const parts = (message.parts ?? []).slice()
      const j = parts.findIndex((x) => x.id === p.part.id)
      if (j === -1) parts.push(p.part)
      else parts[j] = p.part
      messages[i] = { ...message, parts }
      return { ...conv, messages }
    }
    case "message.removed":
      if (p.sessionID !== id) return
      return { ...conv, messages: conv.messages.filter((m) => m.id !== p.messageID) }
    case "session.status":
      if (p.sessionID !== id) return
      return { ...conv, busy: !!p.status && p.status.type !== "idle", retry: p.status && p.status.type === "retry" ? p.status : undefined }
    case "session.idle":
      if (p.sessionID !== id) return
      return { ...conv, busy: false, retry: undefined }
    case "session.error":
      if (p.sessionID !== id) return
      return { ...conv, error: p.error }
    case "session.updated":
      if (!p.info || p.info.id !== id) return
      return { ...conv, title: p.info.title }
    case "permission.asked":
      if (p.sessionID !== id || conv.permissions.some((x) => x.id === p.id)) return
      return { ...conv, permissions: [...conv.permissions, p] }
    case "permission.replied":
      return conv.permissions.some((x) => x.id === p.id) ? { ...conv, permissions: conv.permissions.filter((x) => x.id !== p.id) } : undefined
    case "todo.updated":
      if (p.sessionID !== id) return
      return { ...conv, todos: p.todos ?? [] }
    case "session.reverted":
    case "session.compacted":
      return p.sessionID === id ? "reload" : undefined
  }
  return undefined
}
