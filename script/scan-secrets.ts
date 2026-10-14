/**
 * Fails when tracked files contain credential-shaped strings, private keys, personal e-mail
 * addresses or absolute paths from a developer machine.
 *   bun run script/scan-secrets.ts            (scans `git ls-files`)
 */
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"

export interface Finding {
  file: string
  line: number
  rule: string
  text: string
}

const RULES: { name: string; re: RegExp }[] = [
  { name: "Anthropic key", re: /sk-ant-[A-Za-z0-9_-]{8,}/ },
  { name: "OpenAI-style key", re: /\bsk-(?!test|fake|placeholder|example|xxxx|not-a-real)[A-Za-z0-9_-]{16,}/ },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/ },
  { name: "Google API key", re: /AIza[0-9A-Za-z_-]{30,}/ },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Slack token", re: /\bxox[abprs]-[0-9A-Za-z-]{10,}/ },
  { name: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "developer home path", re: /(?:\/Users\/(?!you\b|name\b|user\b|username\b|\$)[A-Za-z0-9._-]+\/|\/home\/(?!you\b|user\b|runner\b|\$)[A-Za-z0-9._-]+\/|[A-Z]:\\Users\\(?!you\b|user\b|runneradmin\b|Public\b)[A-Za-z0-9._-]+\\)/ },
  { name: "personal e-mail", re: /[A-Za-z0-9._%+-]+@(?!users\.noreply\.github\.com|example\.(?:com|org)|anthropic\.com|localhost)[A-Za-z0-9-]+\.(?:com|net|org|io|kr|dev)\b/ },
]

const SELF = "script/scan-secrets.ts"

/**
 * The one place private keys may be committed: throw-away TLS fixtures for the tests. The rule is
 * deliberately narrow: this directory only, only the private-key rule, and only for files that
 * declare themselves test-only on their first line. Every other rule still applies there.
 */
const TLS_FIXTURES = "test/fixtures/tls/"
const TEST_ONLY_BANNER = "# TEST ONLY."
const isTestOnlyKey = (file: string, text: string) => file.startsWith(TLS_FIXTURES) && file.endsWith(".pem") && text.startsWith(TEST_ONLY_BANNER)
const SKIP_EXT = new Set([".png", ".jpg", ".ico", ".zip", ".gz", ".lock", ".lockb"])

export function trackedFiles(root: string): string[] {
  const r = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
  if (r.status !== 0) throw new Error("git ls-files failed: " + r.stderr)
  return r.stdout.split("\0").filter(Boolean)
}

export function scan(root: string, files = trackedFiles(root)): Finding[] {
  const findings: Finding[] = []
  for (const file of files) {
    if (file === SELF || file === "package-lock.json" || SKIP_EXT.has(path.extname(file))) continue
    let text: string
    try {
      text = fs.readFileSync(path.join(root, file), "utf8")
    } catch {
      continue
    }
    const keyAllowed = isTestOnlyKey(file.split(path.sep).join("/"), text)
    text.split("\n").forEach((line, i) => {
      for (const rule of RULES) {
        if (keyAllowed && rule.name === "private key") continue
        const m = rule.re.exec(line)
        if (m) findings.push({ file, line: i + 1, rule: rule.name, text: m[0].slice(0, 12) + "…" })
      }
    })
  }
  return findings
}

if (import.meta.main) {
  const root = path.resolve(import.meta.dir, "..")
  const findings = scan(root)
  for (const f of findings) console.error(`${f.file}:${f.line}  ${f.rule}  (${f.text})`)
  if (findings.length) {
    console.error(`\n${findings.length} potential secret(s) or local detail(s) found in tracked files.`)
    process.exit(1)
  }
  console.log("secret scan: clean")
}
