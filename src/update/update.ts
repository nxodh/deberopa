import fs from "node:fs/promises"
import fsSync from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { REPO, VERSION } from "../global"
import { getConfig, readState, writeState } from "../config/config"
import { run } from "../util/shell"
import { createLogger } from "../util/log"

const log = createLogger("update")
const DAY = 24 * 60 * 60 * 1000

/** Base URL of the release host; overridable so tests and mirrors can stand in for GitHub. */
const releaseBase = () => (process.env.VEDECAPS_RELEASE_URL || `https://github.com/${REPO}/releases`).replace(/\/+$/, "")

export class UpdateError extends Error {}

export function runtimeLibc(): "glibc" | "musl" {
  if (process.platform !== "linux") return "glibc"
  try {
    if ((process.report?.getReport() as any)?.header?.glibcVersionRuntime) return "glibc"
    if (fsSync.existsSync("/etc/alpine-release") || fsSync.readdirSync("/lib").some((n) => n.startsWith("ld-musl-"))) return "musl"
  } catch {}
  return "glibc"
}

export function targetName(platform = process.platform, arch = process.arch, libc = runtimeLibc()): string {
  const system = platform === "win32" ? "windows" : platform
  if (!["linux", "darwin", "windows"].includes(system) || !["x64", "arm64"].includes(arch) || (system === "windows" && arch !== "x64")) {
    throw new UpdateError(`No prebuilt binary for ${platform}/${arch}. Build from source: https://github.com/${REPO}`)
  }
  return `${system}-${arch}${system === "linux" && libc === "musl" ? "-musl" : ""}`
}

export function assetName(target = targetName()): string {
  return `vedecaps-${target}.${target.startsWith("windows") ? "zip" : "tar.gz"}`
}

/** True when this process is the installed executable rather than a source checkout run through bun. */
export function isCompiled(): boolean {
  return /^vedecaps(\.exe)?$/i.test(path.basename(process.execPath))
}

export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.replace(/^v/, "").split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0)
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0)
  return 0
}

/** Newest released version, read from the redirect of /releases/latest (no API token or rate limit involved). */
export async function latestVersion(timeoutMs = 10_000): Promise<string> {
  const res = await fetch(`${releaseBase()}/latest`, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs), headers: { "User-Agent": `vedecaps/${VERSION}` } })
  const location = res.headers.get("location") ?? ""
  const match = /\/tag\/v?([^/?#]+)/.exec(location)
  if (!match) throw new UpdateError(res.status === 404 || !location ? "No release has been published yet." : `Could not determine the latest version (HTTP ${res.status}).`)
  return match[1]!
}

async function download(url: string, file: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(5 * 60_000), headers: { "User-Agent": `vedecaps/${VERSION}` } })
  if (!res.ok) throw new UpdateError(`Download failed (HTTP ${res.status}): ${url}`)
  await fs.writeFile(file, Buffer.from(await res.arrayBuffer()))
}

async function sha256(file: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(file)).digest("hex")
}

export interface UpgradeResult {
  from: string
  to: string
  path: string
  changed: boolean
}

/**
 * Replace the running executable with a released build. The archive's SHA-256 must match
 * checksums.txt, and the new binary must run and report the expected version before the swap.
 */
export async function upgrade(opts: { version?: string; force?: boolean; onProgress?: (message: string) => void } = {}): Promise<UpgradeResult> {
  const progress = opts.onProgress ?? (() => {})
  if (!isCompiled()) throw new UpdateError("This is a source checkout, not an installed binary. Update it with git instead.")
  const target = process.execPath
  const version = (opts.version ?? (await latestVersion())).replace(/^v/, "")
  if (!opts.force && compareVersions(version, VERSION) === 0) return { from: VERSION, to: version, path: target, changed: false }

  const asset = assetName()
  const base = `${releaseBase()}/download/v${version}`
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vedecaps-upgrade-"))
  try {
    progress(`Downloading ${asset} (v${version})`)
    const archive = path.join(tmp, asset)
    await download(`${base}/${asset}`, archive)
    await download(`${base}/checksums.txt`, path.join(tmp, "checksums.txt"))

    const sums = await fs.readFile(path.join(tmp, "checksums.txt"), "utf8")
    const expected = sums.split(/\r?\n/).map((l) => l.trim().split(/\s+/)).find((p) => p[1]?.replace(/^\*/, "") === asset)?.[0]
    if (!expected) throw new UpdateError(`checksums.txt has no entry for ${asset}`)
    const actual = await sha256(archive)
    if (actual.toLowerCase() !== expected.toLowerCase()) throw new UpdateError(`Checksum mismatch for ${asset}: expected ${expected}, got ${actual}. Nothing was changed.`)
    progress("Checksum verified")

    // bsdtar (shipped with Windows 10+) reads zip as well as tar.gz
    const unpack = await run("tar", ["-xf", archive, "-C", tmp], { timeout: 120_000 })
    if (unpack.code !== 0) throw new UpdateError(`Could not unpack ${asset}: ${unpack.stderr.trim() || "tar failed"}`)
    const exe = process.platform === "win32" ? "vedecaps.exe" : "vedecaps"
    const fresh = path.join(tmp, exe)
    await fs.chmod(fresh, 0o755).catch(() => {})

    const check = await run(fresh, ["--version"], { timeout: 30_000 })
    if (check.code !== 0 || check.stdout.trim() !== version) {
      throw new UpdateError(`The downloaded binary did not run correctly (reported "${check.stdout.trim() || check.stderr.trim()}"). Nothing was changed.`)
    }

    progress(`Installing to ${target}`)
    const staged = `${target}.new`
    await fs.copyFile(fresh, staged)
    await fs.chmod(staged, 0o755).catch(() => {})
    if (process.platform === "win32") {
      // A running .exe cannot be overwritten, but it can be renamed out of the way.
      const old = `${target}.old`
      await fs.rm(old, { force: true }).catch(() => {})
      await fs.rename(target, old)
      try {
        await fs.rename(staged, target)
      } catch (err) {
        await fs.rename(old, target).catch(() => {})
        throw err
      }
    } else {
      await fs.rename(staged, target)
    }
    await writeState({ latestVersion: version, lastUpdateCheck: Date.now() }).catch(() => {})
    return { from: VERSION, to: version, path: target, changed: true }
  } catch (err) {
    if (err instanceof UpdateError) throw err
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === "EACCES" || code === "EPERM") throw new UpdateError(`No permission to replace ${target}. Re-run with the rights needed to write there, or reinstall with the install script.`)
    throw err
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

/** Remove the leftover of a Windows upgrade (the previous exe, renamed while it was running). */
export async function cleanupOldBinary() {
  if (process.platform !== "win32" || !isCompiled()) return
  await fs.rm(`${process.execPath}.old`, { force: true }).catch(() => {})
}

/**
 * At most once a day, look for a newer release. Returns the newer version, if any.
 * Only ever notifies: installing is always an explicit `vedecaps upgrade`.
 */
export async function checkForUpdate(): Promise<string | undefined> {
  try {
    if (process.env.VEDECAPS_DISABLE_UPDATE_CHECK || !isCompiled()) return undefined
    const config = await getConfig()
    if (config.autoupdate === false) return undefined
    const state = await readState()
    let latest = state.latestVersion
    if (!state.lastUpdateCheck || Date.now() - state.lastUpdateCheck > DAY) {
      latest = await latestVersion(5000)
      await writeState({ lastUpdateCheck: Date.now(), latestVersion: latest })
    }
    return latest && compareVersions(latest, VERSION) > 0 ? latest : undefined
  } catch (err) {
    log.debug("update check failed", err)
    return undefined
  }
}
