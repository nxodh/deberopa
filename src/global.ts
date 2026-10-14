import os from "node:os"
import path from "node:path"
import fs from "node:fs"
import pkg from "../package.json"
import { LEGACY_NAME, legacyEnvWarning, migrateEnv, migrateLegacyDirs } from "./legacy"

// The old environment variable prefix keeps working for one release (and says so once).
const legacyEnv = migrateEnv()
{
  const warning = legacyEnvWarning(legacyEnv)
  if (warning) process.stderr.write(warning + "\n")
}

export const NAME = "deberopa"
export const VERSION: string = pkg.version
export const REPO = "nxodh/deberopa"

function resolvePaths(name: string = NAME) {
  const home = os.homedir()
  const override = process.env.DEBEROPA_HOME
  if (override) {
    return {
      home,
      data: path.join(override, "data"),
      config: path.join(override, "config"),
      cache: path.join(override, "cache"),
      state: path.join(override, "state"),
    }
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local")
    const roaming = process.env.APPDATA || path.join(home, "AppData", "Roaming")
    return {
      home,
      data: path.join(local, name),
      config: path.join(roaming, name),
      cache: path.join(local, name, "cache"),
      state: path.join(local, name, "state"),
    }
  }
  return {
    home,
    data: path.join(process.env.XDG_DATA_HOME || path.join(home, ".local", "share"), name),
    config: path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), name),
    cache: path.join(process.env.XDG_CACHE_HOME || path.join(home, ".cache"), name),
    state: path.join(process.env.XDG_STATE_HOME || path.join(home, ".local", "state"), name),
  }
}

const base = resolvePaths()

// First run after the rename: bring settings, logins and sessions over from the old folders.
if (!process.env.DEBEROPA_HOME) {
  const old = resolvePaths(LEGACY_NAME)
  const copied = migrateLegacyDirs({ config: old.config, data: old.data, state: old.state }, { config: base.config, data: base.data, state: base.state })
  if (copied.length) process.stderr.write(`deberopa: copied your ${copied.join(", ")} from the old folders (they were left in place and are not used any more)\n`)
}

/** Well-known directories. Created lazily by `ensureDirs()`. */
export const Paths = {
  ...base,
  storage: path.join(base.data, "storage"),
  snapshot: path.join(base.data, "snapshot"),
  log: path.join(base.data, "log"),
  auth: path.join(base.data, "auth.json"),
}

export function ensureDirs() {
  for (const dir of [Paths.data, Paths.config, Paths.cache, Paths.state, Paths.storage, Paths.log]) {
    fs.mkdirSync(dir, { recursive: true })
  }
}
