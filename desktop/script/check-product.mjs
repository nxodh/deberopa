// Checks a packaged Deberopa Desktop folder against the "must not ship" list of docs/desktop-design.md (section 2.1).
//   node desktop/script/check-product.mjs <packaged-dir>
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const root = process.argv[2]
if (!root || !existsSync(root)) {
  console.error("usage: check-product.mjs <packaged-dir>")
  process.exit(2)
}

function find(dir, name, depth = 6) {
  if (depth < 0) return undefined
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    let st
    try { st = statSync(full) } catch { continue }
    if (entry === name && st.isFile()) return full
    if (st.isDirectory()) {
      const hit = find(full, name, depth - 1)
      if (hit) return hit
    }
  }
}

const failures = []
const fail = (msg) => failures.push(msg)

const productPath = find(join(root), "product.json")
if (!productPath) fail("product.json not found")
else {
  const product = JSON.parse(readFileSync(productPath, "utf8"))
  console.log(`product.json: ${productPath}`)
  console.log(`  nameLong=${product.nameLong} applicationName=${product.applicationName} version=${product.version}`)
  for (const key of ["extensionsGallery", "defaultChatAgent", "voiceWsUrl", "webviewContentExternalBaseUrlTemplate", "updateUrl", "extensionRecommendations"]) {
    if (key in product) fail(`product.json still has "${key}"`)
  }
  if (product.nameLong !== "Deberopa Desktop") fail(`nameLong is ${JSON.stringify(product.nameLong)}`)
  const text = JSON.stringify(product)
  // The build stamps the Copilot SDK versions that core still bundles (see docs/desktop-design.md, 15.1). Known, reported, not failed.
  const { copilotVersions, ...rest } = product
  if (copilotVersions) console.log(`  note: core still bundles the Copilot SDK (${JSON.stringify(copilotVersions)})`)
  if (/copilot/i.test(JSON.stringify(rest))) fail("product.json mentions Copilot")
  if (!Array.isArray(product.builtInExtensionsEnabledWithAutoUpdates)) fail("builtInExtensionsEnabledWithAutoUpdates must stay an array (the workbench iterates it)")
  for (const bad of ["marketplace.visualstudio.com", "open-vsx.org", "api.github.com/copilot", "vscode-cdn.net", "mai.microsoft.com", "update.code.visualstudio.com", "vortex.data.microsoft.com", "dc.services.visualstudio.com"]) {
    if (text.includes(bad)) fail(`product.json mentions ${bad}`)
  }
}

for (const dir of ["extensions/copilot", "resources/app/extensions/copilot"]) {
  if (existsSync(join(root, dir))) fail(`${dir} is present`)
}
const exts = find(root, "extensions", 3)
if (exts === undefined) console.log("(no extensions folder found at depth 3)")

if (failures.length) {
  console.error("\nFAILED:")
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log("\nproduct check passed")
