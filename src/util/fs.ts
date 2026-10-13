import fs from "node:fs/promises"
import path from "node:path"

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

export async function readJSON<T>(p: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(p, "utf8")) as T
  } catch {
    return undefined
  }
}

/** Atomic write: a crash mid-write never leaves a half-written file behind. */
export async function writeJSON(p: string, value: unknown, mode?: number) {
  await fs.mkdir(path.dirname(p), { recursive: true })
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), mode ? { mode } : undefined)
  try {
    await fs.rename(tmp, p)
  } catch (err) {
    // Windows can refuse to replace a file that another handle has open; fall back to a plain write.
    await fs.writeFile(p, JSON.stringify(value, null, 2), mode ? { mode } : undefined)
    await fs.rm(tmp, { force: true })
  }
}

/** Walk upwards from `start` collecting every existing `name`, nearest first. */
export async function findUp(names: string[], start: string, stop?: string): Promise<string[]> {
  const found: string[] = []
  let dir = path.resolve(start)
  while (true) {
    for (const name of names) {
      const candidate = path.join(dir, name)
      if (await exists(candidate)) found.push(candidate)
    }
    if (stop && path.resolve(stop) === dir) break
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return found
}

export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

/** Forward slashes everywhere so output reads the same on Windows and Linux. */
export function toPosix(p: string): string {
  return p.split(path.sep).join("/")
}
