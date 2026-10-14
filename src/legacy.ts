import fs from "node:fs"
import path from "node:path"

/**
 * Names from before the product was called Deberopa. They are read for one release so that an
 * existing installation keeps its settings, sessions and scripts; nothing is ever written to them.
 * This is the only place that spells the old name.
 */
export const LEGACY_NAME = "vedecaps"
const OLD_PREFIX = "VEDECAPS_"
const NEW_PREFIX = "DEBEROPA_"

/**
 * Give every `VEDECAPS_*` variable its `DEBEROPA_*` name when the new one is not set. Returns the
 * old names that were used, so the caller can warn once.
 */
export function migrateEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const used: string[] = []
  for (const key of Object.keys(env)) {
    if (!key.startsWith(OLD_PREFIX) || env[key] === undefined) continue
    const next = NEW_PREFIX + key.slice(OLD_PREFIX.length)
    if (env[next] !== undefined) continue
    env[next] = env[key]
    used.push(key)
  }
  return used
}

export function legacyEnvWarning(used: string[]): string | undefined {
  if (used.length === 0) return undefined
  const pairs = used.map((k) => `${k} -> ${NEW_PREFIX}${k.slice(OLD_PREFIX.length)}`).join(", ")
  return `deberopa: the old environment variable name${used.length === 1 ? " is" : "s are"} deprecated and will stop being read in a later release. Rename: ${pairs}`
}

export interface DirSet {
  config: string
  data: string
  state: string
}

const exists = (p: string) => {
  try {
    fs.statSync(p)
    return true
  } catch {
    return false
  }
}

/**
 * First run after the rename: when the new folder does not exist and the old one does, copy what
 * the user would miss (settings, saved logins, sessions, trusted projects). The old folder is left
 * untouched and is never written to again. Returns the kinds that were copied.
 */
export function migrateLegacyDirs(legacy: DirSet, current: DirSet): string[] {
  const copied: string[] = []
  const attempt = (kind: string, fn: () => void) => {
    try {
      fn()
      copied.push(kind)
    } catch {
      // a folder we cannot read is simply not migrated; the app starts with empty settings
    }
  }

  if (!exists(current.config) && exists(legacy.config)) {
    attempt("settings", () => {
      fs.cpSync(legacy.config, current.config, { recursive: true })
      for (const ext of ["json", "jsonc"]) {
        const old = path.join(current.config, `${LEGACY_NAME}.${ext}`)
        if (exists(old)) fs.renameSync(old, path.join(current.config, `deberopa.${ext}`))
      }
    })
  }

  if (!exists(current.data) && exists(legacy.data)) {
    attempt("logins and sessions", () => {
      fs.mkdirSync(current.data, { recursive: true, mode: 0o700 })
      const auth = path.join(legacy.data, "auth.json")
      if (exists(auth)) {
        fs.copyFileSync(auth, path.join(current.data, "auth.json"))
        if (process.platform !== "win32") fs.chmodSync(path.join(current.data, "auth.json"), 0o600)
      }
      const storage = path.join(legacy.data, "storage")
      if (exists(storage)) fs.cpSync(storage, path.join(current.data, "storage"), { recursive: true })
    })
  }

  if (!exists(current.state) && exists(legacy.state)) {
    attempt("state", () => fs.cpSync(legacy.state, current.state, { recursive: true }))
  }
  return copied
}
