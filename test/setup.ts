import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// One throwaway home for the whole test run: nothing touches the developer's real config or credentials.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "vdc-home-"))
process.env.VEDECAPS_HOME = home
process.env.VEDECAPS_DISABLE_MODELS_FETCH = "1"
process.env.VEDECAPS_MODELS_URL = "http://127.0.0.1:9/none"
for (const key of Object.keys(process.env)) {
  if (/(_API_KEY|_TOKEN)$/.test(key) || key === "GOOGLE_GENERATIVE_AI_API_KEY") delete process.env[key]
}
delete process.env.VEDECAPS_CONFIG
delete process.env.VEDECAPS_CONFIG_CONTENT
process.on("exit", () => {
  try {
    fs.rmSync(home, { recursive: true, force: true })
  } catch {}
})
