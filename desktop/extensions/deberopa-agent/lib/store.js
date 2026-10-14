"use strict"
// Conversation state for one session, kept in step with the server's event stream.

function createState() {
  return { sessionID: undefined, title: "", busy: false, retry: undefined, messages: [], permissions: [], todos: [], error: undefined }
}

function upsertMessage(state, message) {
  const index = state.messages.findIndex((m) => m.id === message.id)
  if (index === -1) state.messages.push(message)
  else state.messages[index] = { ...state.messages[index], ...message, parts: message.parts ?? state.messages[index].parts }
}

/**
 * Applies one server event. Returns "reload" when the history changed in a way that is simpler to
 * refetch (revert, compaction), otherwise undefined.
 */
function applyEvent(state, event) {
  const p = event.properties ?? {}
  switch (event.type) {
    case "message.updated":
      if (p.message && p.message.sessionID === state.sessionID) upsertMessage(state, p.message)
      return
    case "message.part.updated": {
      if (p.sessionID !== state.sessionID) return
      const message = state.messages.find((m) => m.id === p.messageID)
      if (!message || !p.part) return
      const parts = message.parts ?? (message.parts = [])
      const index = parts.findIndex((x) => x.id === p.part.id)
      if (index === -1) parts.push(p.part)
      else parts[index] = p.part
      return
    }
    case "message.removed":
      if (p.sessionID === state.sessionID) state.messages = state.messages.filter((m) => m.id !== p.messageID)
      return
    case "session.status":
      if (p.sessionID !== state.sessionID) return
      state.busy = p.status && p.status.type !== "idle"
      state.retry = p.status && p.status.type === "retry" ? p.status : undefined
      return
    case "session.idle":
      if (p.sessionID === state.sessionID) { state.busy = false; state.retry = undefined }
      return
    case "session.error":
      if (p.sessionID === state.sessionID) state.error = p.error
      return
    case "session.updated":
      if (p.info && p.info.id === state.sessionID) state.title = p.info.title
      return
    case "permission.asked":
      if (!state.permissions.some((x) => x.id === p.id)) state.permissions.push(p)
      return
    case "permission.replied":
      state.permissions = state.permissions.filter((x) => x.id !== p.id)
      return
    case "todo.updated":
      if (p.sessionID === state.sessionID) state.todos = p.todos ?? []
      return
    case "session.reverted":
    case "session.compacted":
      if (p.sessionID === state.sessionID) return "reload"
      return
  }
}

module.exports = { createState, applyEvent }
