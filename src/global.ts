import os from "node:os"
import path from "node:path"
import fs from "node:fs"
import pkg from "../package.json"

export const NAME = "vedecaps"
export const VERSION: string = pkg.version
export const REPO = "nxodh/vedecaps"

function resolvePaths() {
  const home = os.homedir()
  const override = process.env.VEDECAPS_HOME
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
      data: path.join(local, NAME),
      config: path.join(roaming, NAME),
      cache: path.join(local, NAME, "cache"),
      state: path.join(local, NAME, "state"),
    }
  }
  return {
    home,
    data: path.join(process.env.XDG_DATA_HOME || path.join(home, ".local", "share"), NAME),
    config: path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), NAME),
    cache: path.join(process.env.XDG_CACHE_HOME || path.join(home, ".cache"), NAME),
    state: path.join(process.env.XDG_STATE_HOME || path.join(home, ".local", "state"), NAME),
  }
}

const base = resolvePaths()

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
