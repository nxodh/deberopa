// Builds Deberopa Desktop from the pinned Code - OSS source.
//   node desktop/script/build.mjs --work <dir> [--target linux-x64|win32-x64] [--stage fetch|patch|install|compile|package|bundle-cli|all] [--cli <deberopa executable>]
// Runs the same way on Debian 13 and Windows 11. No POSIX tools are used.
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const desktop = resolve(here, "..")
const pin = JSON.parse(readFileSync(join(desktop, "vscode.json"), "utf8"))

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const work = resolve(opt("work", join(desktop, "..", ".desktop-work")))
const stage = opt("stage", "all")
const target = opt("target", process.platform === "win32" ? "win32-x64" : "linux-x64")
const src = join(work, "vscode")

if (!["linux-x64", "win32-x64"].includes(target)) {
  console.error(`unsupported target ${target} (only x86-64 Debian 13 and Windows 11 are supported)`)
  process.exit(2)
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm"
function run(cmd, cmdArgs, cwd = src, env = {}) {
  console.log(`\n$ ${cmd} ${cmdArgs.join(" ")}   (${cwd})`)
  const r = spawnSync(cmd, cmdArgs, { cwd, stdio: "inherit", env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1", ...env }, shell: process.platform === "win32" && cmd.endsWith(".cmd") })
  if (r.status !== 0) {
    console.error(`failed: ${cmd} ${cmdArgs.join(" ")} (exit ${r.status})`)
    process.exit(r.status ?? 1)
  }
}
function out(cmd, cmdArgs, cwd = src) {
  const r = spawnSync(cmd, cmdArgs, { cwd, encoding: "utf8" })
  if (r.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(" ")}: ${r.stderr}`)
  return r.stdout.trim()
}
// "all" is fetch, patch, install and package, plus bundle-cli when --cli is given. compile is only for checking the sources.
const want = (s) => stage === s || (stage === "all" && s !== "compile" && (s !== "bundle-cli" || opt("cli") !== undefined))

if (process.version.split(".")[0] !== `v${pin.node.split(".")[0]}`) {
  console.error(`Node ${pin.node} is required, found ${process.version}`)
  process.exit(2)
}
if (process.version !== `v${pin.node}`) console.warn(`warning: pinned Node is ${pin.node}, running ${process.version}`)

if (want("fetch")) {
  mkdirSync(work, { recursive: true })
  if (!existsSync(join(src, ".git"))) {
    run("git", ["clone", "-c", "core.autocrlf=false", "-c", "core.eol=lf", "-c", "filter.lfs.smudge=", "-c", "filter.lfs.process=", "-c", "filter.lfs.required=false", "--depth", "1", "--branch", pin.tag, "https://github.com/microsoft/vscode.git", src], work)
  }
  const head = out("git", ["rev-parse", "HEAD"])
  if (head !== pin.commit) {
    console.error(`vscode ${pin.tag} is ${head}, expected ${pin.commit}; refusing to build`)
    process.exit(3)
  }
}

if (want("patch")) {
  const dir = join(desktop, "patches")
  const patches = readdirSync(dir).filter((f) => f.endsWith(".patch")).sort()
  const applied = join(src, ".deberopa-patched")
  if (existsSync(applied)) {
    console.log("patches already applied")
  } else {
    for (const p of patches) run("git", ["apply", "--whitespace=nowarn", join(dir, p)])
    // Whole directories we do not ship (listed in desktop/remove.json) are deleted before anything installs.
    for (const rel of JSON.parse(readFileSync(join(desktop, "remove.json"), "utf8"))) rmSync(join(src, rel), { recursive: true, force: true })
    // Files that are removed or replaced wholesale live in desktop/overlay and are copied over the tree.
    const overlay = join(desktop, "overlay")
    if (existsSync(overlay)) cpSync(overlay, src, { recursive: true })
    // Built-in extensions written for Deberopa Desktop (desktop/extensions/*) join the upstream ones.
    const own = join(desktop, "extensions")
    if (existsSync(own)) for (const name of readdirSync(own)) cpSync(join(own, name), join(src, "extensions", name), { recursive: true })
    // Product identity: merge desktop/branding/product.json over the upstream product.json.
    const upstream = JSON.parse(readFileSync(join(src, "product.json"), "utf8"))
    const brand = JSON.parse(readFileSync(join(desktop, "branding", "product.json"), "utf8"))
    const remove = brand.$remove ?? []
    delete brand.$remove
    for (const key of remove) delete upstream[key]
    writeFileSync(join(src, "product.json"), JSON.stringify({ ...upstream, ...brand }, null, "\t") + "\n")
    writeFileSync(applied, patches.join("\n") + "\n")
  }
}

if (want("install")) run(npm, ["ci"])
if (want("compile")) run(npm, ["run", "compile-client"])
const packaged = join(work, `VSCode-${target}`)
if (want("package")) {
  run(npm, ["run", "gulp", `vscode-${target}-min`])
  console.log(`\npackaged: ${packaged}`)
}
if (want("bundle-cli")) {
  // The agent extension starts the CLI that ships next to the app (resources/deberopa/deberopa[.exe]).
  const cli = opt("cli")
  if (!cli || !existsSync(cli)) {
    console.error("--cli <path to the deberopa executable for this target> is required for the bundle-cli stage")
    process.exit(2)
  }
  const dest = join(packaged, "resources", "deberopa")
  mkdirSync(dest, { recursive: true })
  cpSync(cli, join(dest, target === "win32-x64" ? "deberopa.exe" : "deberopa"))
  console.log(`bundled CLI: ${dest}`)
}
