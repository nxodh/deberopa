import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// One throwaway home for the whole test run: nothing touches the developer's real config or credentials.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "vdc-home-"))
process.env.DEBEROPA_HOME = home
process.env.DEBEROPA_DISABLE_MODELS_FETCH = "1"
// tests must not depend on whatever happens to be listening on the developer's localhost
process.env.DEBEROPA_DISABLE_LOCAL_DETECT = "1"
// most tests write their own project config and want it honoured; trust.test.ts turns this off
process.env.DEBEROPA_TRUST_PROJECT = "1"
process.env.DEBEROPA_MODELS_URL = "http://127.0.0.1:9/none"
for (const key of Object.keys(process.env)) {
  if (/(_API_KEY|_TOKEN)$/.test(key) || key === "GOOGLE_GENERATIVE_AI_API_KEY") delete process.env[key]
}
delete process.env.DEBEROPA_CONFIG
delete process.env.DEBEROPA_CONFIG_CONTENT
process.on("exit", () => {
  try {
    fs.rmSync(home, { recursive: true, force: true })
  } catch {}
})
