import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { scan } from "../script/scan-secrets"
import { maskKey, redact, redactDeep, registerSecret } from "../src/util/redact"

test("tracked files contain no credentials or developer-machine details", () => {
  expect(scan(path.resolve(import.meta.dir, ".."))).toEqual([])
})

test("the scanner catches key shapes, private keys, home paths and e-mail", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vdc-scan-"))
  const fake = {
    "a.txt": "const k = 'sk-" + "A".repeat(24) + "'",
    "b.txt": "token ghp_" + "b".repeat(30),
    "c.txt": "-----BEGIN RSA PRIVATE" + " KEY-----",
    "d.txt": "/Users/" + "alice/project",
    "e.txt": "mail alice" + "@gmail.com",
    "ok.txt": "sk-test-not-a-real-key and /Users/you/x and bot@users.noreply.github.com",
  }
  for (const [name, body] of Object.entries(fake)) fs.writeFileSync(path.join(dir, name), body)
  const found = scan(dir, Object.keys(fake)).map((f) => f.file)
  expect(found.sort()).toEqual(["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"])
  fs.rmSync(dir, { recursive: true, force: true })
})

test("redaction scrubs key shapes and registered secrets", () => {
  registerSecret("hunter2-super-secret")
  expect(redact("Incorrect API key: sk-" + "x".repeat(30))).toBe("Incorrect API key: [redacted]")
  expect(redact("password is hunter2-super-secret ok")).toBe("password is [redacted] ok")
  expect(redact("Authorization: Bearer " + "a".repeat(30))).not.toContain("aaaa")
  expect(maskKey("sk-test-not-a-real-key")).toBe("sk-…-key")
  const masked = redactDeep({ provider: { x: { options: { apiKey: "sk-test-not-a-real-key", baseURL: "http://h" } } } })
  expect(masked.provider.x.options.apiKey).not.toContain("not-a-real")
  expect(masked.provider.x.options.baseURL).toBe("http://h")
})

test("credential file is owner-only", async () => {
  if (process.platform === "win32") return
  const { setCredential } = await import("../src/auth/auth")
  const { Paths } = await import("../src/global")
  await setCredential("mock", { type: "api", key: "sk-test-not-a-real-key" })
  expect(fs.statSync(Paths.auth).mode & 0o777).toBe(0o600)
})
