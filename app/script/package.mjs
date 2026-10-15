// Packages the app with the CLI inside it:
//   node script/package.mjs --platform linux|win32|darwin --cli <path to the deberopa binary> [--out dir] [--arch x64|arm64]
// The result is a folder (Deberopa-<platform>-<arch>) with the Electron runtime, the app in an
// asar archive and the CLI next to it in resources/. The renderer is already bundled, so no
// node_modules are shipped.
import { packager } from "@electron/packager"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}

const platform = option("platform", process.platform)
const arch = option("arch", "x64")
const cli = option("cli")
const out = path.resolve(option("out", path.join(root, "out")))
if (!cli || !fs.existsSync(cli)) {
  console.error("--cli must point at the built deberopa executable")
  process.exit(1)
}
if (!fs.existsSync(path.join(root, "dist", "index.js"))) {
  console.error("dist/ is missing: run `npm run build` first")
  process.exit(1)
}

// only what the running app reads
const keep = (p) =>
  p === "" ||
  ["/main.cjs", "/preload.cjs", "/package.json", "/build", "/lib", "/dist", "/test", "/test/smoke.cjs"].includes(p) ||
  p.startsWith("/build/") ||
  p.startsWith("/lib/") ||
  p.startsWith("/dist/")

const paths = await packager({
  dir: root,
  out,
  name: "Deberopa",
  executableName: platform === "linux" ? "deberopa-desktop" : undefined,
  platform,
  arch,
  overwrite: true,
  asar: true,
  prune: false,
  appVersion: pkg.version,
  appCopyright: "Copyright (C) 2026 nxodh. MIT License",
  // the packager adds .ico / .icns itself and falls back to the Electron icon when the file is missing
  icon: platform === "win32" || platform === "darwin" ? path.join(root, "build", "icon") : undefined,
  extraResource: [cli],
  ignore: (p) => !keep(p),
  win32metadata: { CompanyName: "nxodh", FileDescription: "Deberopa Desktop", ProductName: "Deberopa", OriginalFilename: "Deberopa.exe" },
})
// the Electron icon must not be what ships
for (const p of paths) {
  if (platform === "win32" && !fs.existsSync(path.join(p, "Deberopa.exe"))) throw new Error("Deberopa.exe is missing")
  if (platform === "darwin") {
    const resources = path.join(p, "Deberopa.app", "Contents", "Resources")
    const icons = fs.readdirSync(resources).filter((f) => f.endsWith(".icns"))
    const ours = fs.readFileSync(path.join(root, "build", "icon.icns"))
    if (!icons.some((f) => fs.readFileSync(path.join(resources, f)).equals(ours))) throw new Error(`the Deberopa icon is not in the app (found: ${icons.join(", ")})`)
  }
  console.log(p)
}
