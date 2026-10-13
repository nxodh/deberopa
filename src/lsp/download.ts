import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createHash } from "node:crypto"
import { run } from "../util/shell"
import { runtimeLibc } from "../update/update"

export type DownloadServer = "clangd" | "zls" | "lua-language-server"
const repos: Record<DownloadServer, string> = { clangd: "clangd/clangd", zls: "zigtools/zls", "lua-language-server": "LuaLS/lua-language-server" }

export function assetPattern(id: DownloadServer, platform = process.platform, arch = process.arch): RegExp {
  if (!["x64", "arm64"].includes(arch) || !["linux", "darwin", "win32"].includes(platform)) throw new Error(`No ${id} build for ${platform}/${arch}`)
  if (id === "clangd") {
    if (arch !== "x64" && platform !== "darwin") throw new Error(`The official clangd release has no ${platform}/${arch} binary. Install clangd through your system package manager.`)
    return new RegExp(`^clangd-${platform === "darwin" ? "mac" : platform === "win32" ? "windows" : "linux"}-[0-9.]+\\.zip$`)
  }
  if (id === "zls") return new RegExp(`^zls-${arch === "arm64" ? "aarch64" : "x86_64"}-${platform === "darwin" ? "macos" : platform === "win32" ? "windows" : "linux"}\\.(?:tar\\.xz|zip)$`)
  return new RegExp(`^lua-language-server-[0-9.]+-${platform}-${arch}\\.(?:tar\\.gz|zip)$`)
}

export function safeArchiveNames(list: string): boolean {
  const names = list.trim().split(/\r?\n/)
  return names.length > 0 && names.length < 50_000 && names.every((name) =>
    !!name && !/^[\\/]|[\\:\u0000-\u001f]/.test(name) && !name.split("/").includes("..")
  )
}

export async function downloadServer(id: DownloadServer, dir: string, say: (message: string) => void, signal?: AbortSignal): Promise<void> {
  if (process.platform === "linux" && runtimeLibc() === "musl" && id !== "zls") {
    throw new Error(`The official ${id} download requires glibc. Install the Alpine package instead.`)
  }
  const repo = repos[id]
  let release = "latest"
  if (id === "zls") {
    const zig = await run("zig", ["version"])
    const minor = /^(\d+\.\d+)\.\d+\s*$/.exec(zig.stdout.trim())?.[1]
    if (!minor) throw new Error("Install a stable Zig release first; ZLS must match its major/minor version.")
    release = `tags/${minor}.0`
  }
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)]) : AbortSignal.timeout(5 * 60_000)
  const metadata = await fetch(`https://api.github.com/repos/${repo}/releases/${release}`, { signal: requestSignal, headers: { "User-Agent": "vedecaps", Accept: "application/vnd.github+json" } })
  if (!metadata.ok) throw new Error(`Could not read the official ${id} release (HTTP ${metadata.status})`)
  const data: any = await metadata.json()
  const pattern = assetPattern(id)
  const asset = data.assets?.find((a: any) => typeof a.name === "string" && pattern.test(a.name))
  if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? "")) throw new Error(`No supported, SHA-256-verifiable ${id} asset was published for this platform`)
  const url = new URL(asset.browser_download_url)
  if (url.origin !== "https://github.com" || !url.pathname.startsWith(`/${repo}/releases/download/`) || asset.size > 200 * 1024 * 1024) throw new Error("Unexpected release download URL or size")
  say(`Downloading ${asset.name} from ${repo} (SHA-256 verified)`)
  const response = await fetch(url, { signal: requestSignal })
  if (!response.ok) throw new Error(`Download failed (HTTP ${response.status})`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length !== asset.size || "sha256:" + createHash("sha256").update(bytes).digest("hex") !== asset.digest) throw new Error("Language server checksum mismatch; nothing was installed")
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "vdc-lsp-download-"))
  try {
    const archive = path.join(scratch, asset.name)
    await fs.writeFile(archive, bytes)
    const names = await run("tar", ["-tf", archive])
    const details = await run("tar", ["-tvf", archive])
    if (names.code !== 0 || details.code !== 0 || !safeArchiveNames(names.stdout) ||
      details.stdout.trim().split(/\r?\n/).some((line) => !/^[-d][rwxstST-]{9}\s/.test(line))) {
      throw new Error("Unsafe or unsupported archive entries (links and special files are not accepted)")
    }
    const stage = path.join(scratch, "payload")
    await fs.mkdir(stage)
    const unpack = await run("tar", ["-xf", archive, "-C", stage], { timeout: 60_000 })
    if (unpack.code !== 0) throw new Error("Could not unpack the language server")
    const executable = id + (process.platform === "win32" ? ".exe" : "")
    const member = names.stdout.split(/\r?\n/).find((name) => path.posix.basename(name) === executable)
    if (!member) throw new Error("The archive contains no language server executable")
    // Keep scripts, libraries, and license files beside the binary, particularly for LuaLS.
    const parent = path.dirname(path.join(stage, member))
    const root = path.basename(parent) === "bin" ? path.dirname(parent) : parent
    await fs.mkdir(dir, { recursive: true })
    const destination = path.join(dir, "payload")
    await fs.rm(destination, { recursive: true, force: true })
    await fs.cp(root, destination, { recursive: true })
    const bin = path.join(destination, path.relative(root, path.join(stage, member)))
    await fs.chmod(bin, 0o755)
    await fs.writeFile(path.join(dir, "launch.json"), JSON.stringify({ command: [bin], release: data.tag_name, digest: asset.digest }))
  } finally { await fs.rm(scratch, { recursive: true, force: true }) }
}
