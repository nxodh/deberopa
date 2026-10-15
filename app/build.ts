// Bundles the renderer (React) into dist/ next to index.html and the stylesheet.
import fs from "node:fs"
import path from "node:path"

const root = import.meta.dir
const dist = path.join(root, "dist")
fs.rmSync(dist, { recursive: true, force: true })
fs.mkdirSync(dist, { recursive: true })

const result = await Bun.build({
  entrypoints: [path.join(root, "src", "index.tsx")],
  outdir: dist,
  target: "browser",
  // a classic <script> would turn top-level functions (CodeMirror has a getSelection) into window properties
  format: "iife",
  minify: false,
  sourcemap: "none",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
})
if (!result.success) {
  for (const log of result.logs) console.error(String(log))
  process.exit(1)
}
fs.copyFileSync(path.join(root, "index.html"), path.join(dist, "index.html"))
fs.copyFileSync(path.join(root, "src", "style.css"), path.join(dist, "style.css"))
console.log(`built ${path.relative(process.cwd(), dist) || "dist"}`)
