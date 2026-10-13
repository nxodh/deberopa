/**
 * Build single-file executables.
 *   bun run script/build.ts                  current platform only -> dist/vedecaps[.exe]
 *   bun run script/build.ts --all            every release target, packaged + checksums.txt
 *   bun run script/build.ts --target linux-arm64 [--package]
 */
import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import pkg from "../package.json"

interface Target {
  name: string
  bun: string
  exe: string
  archive: "tar.gz" | "zip"
}

const TARGETS: Target[] = [
  { name: "linux-x64", bun: "bun-linux-x64", exe: "vedecaps", archive: "tar.gz" },
  { name: "linux-arm64", bun: "bun-linux-arm64", exe: "vedecaps", archive: "tar.gz" },
  { name: "darwin-arm64", bun: "bun-darwin-arm64", exe: "vedecaps", archive: "tar.gz" },
  { name: "darwin-x64", bun: "bun-darwin-x64", exe: "vedecaps", archive: "tar.gz" },
  { name: "windows-x64", bun: "bun-windows-x64", exe: "vedecaps.exe", archive: "zip" },
]

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(`--${name}`)
const option = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? undefined : args[i + 1]
}

const root = path.resolve(import.meta.dir, "..")
const dist = path.resolve(option("outdir") ?? path.join(root, "dist"))

function currentTarget(): Target {
  const os = process.platform === "win32" ? "windows" : process.platform
  const found = TARGETS.find((t) => t.name === `${os}-${process.arch}`)
  if (!found) throw new Error(`No build target for ${process.platform}/${process.arch}`)
  return found
}

const selected = flag("all")
  ? TARGETS
  : option("target")
    ? [TARGETS.find((t) => t.name === option("target")) ?? fail(`Unknown target "${option("target")}". Known: ${TARGETS.map((t) => t.name).join(", ")}`)]
    : [currentTarget()]
const packageIt = flag("all") || flag("package")

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

// Ink references react-devtools-core statically; it is only used when DEV=true and is not installed.
const stubDevtools: Bun.BunPlugin = {
  name: "stub-devtools",
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: "devtools-stub", namespace: "stub" }))
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "export default { initialize() {}, connectToDevTools() {} }",
      loader: "js",
    }))
  },
}

fs.mkdirSync(dist, { recursive: true })
const checksums: string[] = []

for (const target of selected) {
  const dir = path.join(dist, target.name)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const outfile = path.join(dir, target.exe)
  const started = Date.now()
  const result = await Bun.build({
    entrypoints: [path.join(root, "src", "index.ts")],
    compile: { target: target.bun as any, outfile },
    minify: true,
    plugins: [stubDevtools],
  })
  if (!result.success) {
    for (const log of result.logs) console.error(String(log))
    fail(`Build failed for ${target.name}`)
  }
  const size = (fs.statSync(outfile).size / 1024 / 1024).toFixed(1)
  console.log(`built ${target.name} (${size} MB, ${((Date.now() - started) / 1000).toFixed(1)}s) -> ${path.relative(root, outfile)}`)

  if (!packageIt) continue
  const archive = path.join(dist, `vedecaps-${target.name}.${target.archive}`)
  fs.rmSync(archive, { force: true })
  const packed =
    target.archive === "zip"
      ? spawnSync("zip", ["-j", "-q", archive, outfile], { stdio: "inherit" })
      : spawnSync("tar", ["-czf", archive, "-C", dir, target.exe], { stdio: "inherit" })
  if (packed.status !== 0) fail(`Packaging ${target.name} failed (is ${target.archive === "zip" ? "zip" : "tar"} installed?)`)
  const digest = createHash("sha256").update(fs.readFileSync(archive)).digest("hex")
  checksums.push(`${digest}  ${path.basename(archive)}`)
  console.log(`packaged ${path.basename(archive)}  sha256 ${digest.slice(0, 16)}…`)
}

if (packageIt && checksums.length) {
  fs.writeFileSync(path.join(dist, "checksums.txt"), checksums.join("\n") + "\n")
  console.log(`wrote ${path.relative(root, path.join(dist, "checksums.txt"))} (vedecaps ${pkg.version})`)
}
