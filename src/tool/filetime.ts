import fs from "node:fs/promises"
import path from "node:path"

/** When each session last read each file. Guards against editing content the model has never seen or that changed underneath it. */
const reads = new Map<string, Map<string, number>>()

const key = (file: string) => (process.platform === "win32" ? path.normalize(file).toLowerCase() : path.normalize(file))

export function markRead(sessionID: string, file: string) {
  let session = reads.get(sessionID)
  if (!session) reads.set(sessionID, (session = new Map()))
  session.set(key(file), Date.now())
}

export async function assertFresh(sessionID: string, file: string) {
  const time = reads.get(sessionID)?.get(key(file))
  if (time === undefined) {
    throw new Error(`You must read the file ${file} before overwriting or editing it. Use the read tool first.`)
  }
  const stat = await fs.stat(file).catch(() => undefined)
  // A little slack: coarse filesystem timestamps can land just after our own write.
  if (stat && stat.mtimeMs > time + 50) {
    throw new Error(
      `File ${file} has been modified since it was last read (modified ${new Date(stat.mtimeMs).toISOString()}, read ${new Date(time).toISOString()}). Read it again before modifying it.`,
    )
  }
}

export function clearSession(sessionID: string) {
  reads.delete(sessionID)
}
