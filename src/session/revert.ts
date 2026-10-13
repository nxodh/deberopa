import { publish } from "../util/bus"
import { revertFiles, track } from "../snapshot/snapshot"
import { requireSession, getMessages, updateSession } from "./store"
import type { Message, PatchPart, SessionInfo, UserMessage } from "./message"
import { isBusy } from "./prompt"

export class RevertError extends Error {}

/** Messages the user can still see: everything before the undo point. */
export async function visibleMessages(sessionID: string): Promise<Message[]> {
  const [session, messages] = await Promise.all([requireSession(sessionID), getMessages(sessionID)])
  const cut = session.revert?.messageID
  return cut ? messages.filter((m) => m.id < cut) : messages
}

/** The user messages that can be undone to, oldest first (compaction markers and subagent prompts excluded). */
export async function undoPoints(sessionID: string): Promise<UserMessage[]> {
  return (await getMessages(sessionID)).filter(
    (m): m is UserMessage => m.role === "user" && !m.compaction && !m.parts.every((p) => p.type === "text" && p.synthetic),
  )
}

/**
 * Rewind to just before `messageID`: file changes made by later steps are rolled back (using
 * the snapshots recorded in each step's `patch` part) and later messages are hidden until
 * `unrevert`, or deleted once the next prompt is sent.
 */
export async function revert(sessionID: string, messageID: string): Promise<{ session: SessionInfo; files: string[] }> {
  if (isBusy(sessionID)) throw new RevertError("Wait for the current turn to finish (or interrupt it) before undoing.")
  const session = await requireSession(sessionID)
  const all = await getMessages(sessionID)
  if (!all.some((m) => m.id === messageID)) throw new RevertError(`Message not found: ${messageID}`)

  // Always compute from the newest state, so moving the undo point back and forth stays consistent.
  let snapshot = session.revert?.snapshot
  const known = new Set(session.revert?.files ?? [])
  if (session.revert && snapshot) await revertFiles(snapshot, [...known])
  else snapshot = await track()

  // For every file, the earliest snapshot at or after the cut is the state to return to.
  const earliest = new Map<string, string>()
  for (const message of all) {
    if (message.id < messageID) continue
    for (const part of message.parts) {
      if (part.type !== "patch") continue
      for (const file of (part as PatchPart).files) if (!earliest.has(file)) earliest.set(file, part.hash)
    }
  }
  const byHash = new Map<string, string[]>()
  for (const [file, hash] of earliest) byHash.set(hash, [...(byHash.get(hash) ?? []), file])
  for (const [hash, files] of byHash) await revertFiles(hash, files)
  for (const file of earliest.keys()) known.add(file)

  const info = await updateSession(sessionID, (s) => {
    s.revert = { messageID, snapshot, files: [...known] }
  })
  publish("session.reverted", { sessionID, messageID })
  return { session: info, files: [...earliest.keys()] }
}

/** Undo the most recent undo point (or one step further back when already rewound). */
export async function undo(sessionID: string) {
  const session = await requireSession(sessionID)
  const points = await undoPoints(sessionID)
  const visible = session.revert ? points.filter((m) => m.id < session.revert!.messageID) : points
  const target = visible.at(-1)
  if (!target) throw new RevertError("Nothing to undo.")
  return { ...(await revert(sessionID, target.id)), message: target }
}

/** Bring back everything an undo hid, restoring the files as they were. */
export async function unrevert(sessionID: string): Promise<SessionInfo> {
  if (isBusy(sessionID)) throw new RevertError("Wait for the current turn to finish before redoing.")
  const session = await requireSession(sessionID)
  if (!session.revert) throw new RevertError("Nothing to redo.")
  if (session.revert.snapshot) await revertFiles(session.revert.snapshot, session.revert.files ?? [])
  const info = await updateSession(sessionID, (s) => {
    delete s.revert
  })
  publish("session.reverted", { sessionID })
  return info
}

/** Redo one step: move the undo point forward, or finish when it was the last. */
export async function redo(sessionID: string) {
  const session = await requireSession(sessionID)
  if (!session.revert) throw new RevertError("Nothing to redo.")
  const next = (await undoPoints(sessionID)).find((m) => m.id > session.revert!.messageID)
  if (!next) return { session: await unrevert(sessionID), done: true }
  return { ...(await revert(sessionID, next.id)), done: false }
}
