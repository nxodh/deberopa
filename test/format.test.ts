import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

// Must be set before any project module that computes Paths is imported.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "vedecaps-fmt-home-"))
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vedecaps-fmt-proj-"))
process.env.VEDECAPS_HOME = home
delete process.env.VEDECAPS_CONFIG_CONTENT // a previous test file may have left one behind

const { initProject } = await import("../src/project")
const { resetConfig } = await import("../src/config/config")
const { BUILTIN_FORMATTERS, formatFile, formatterStatus, resetFormatters } = await import("../src/format/format")

// `bun -e <code> <file>` exposes the file as the last argv entry.
const UPPERCASE_JS = "const fs = require('fs'); const f = process.argv[process.argv.length - 1]; fs.writeFileSync(f, fs.readFileSync(f, 'utf8').toUpperCase())"
const upper = { command: [process.execPath, "-e", UPPERCASE_JS, "$FILE"], extensions: [".txt"] }

function setConfig(config: unknown) {
  fs.writeFileSync(path.join(dir, "vedecaps.json"), JSON.stringify(config))
  resetConfig()
  resetFormatters()
}

function write(name: string, content: string) {
  const file = path.join(dir, name)
  fs.writeFileSync(file, content)
  return file
}

beforeAll(() => {
  initProject(dir)
})

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(dir, { recursive: true, force: true })
})

describe("formatFile", () => {
  test("custom formatter rewrites the file and reports its name", async () => {
    setConfig({ formatter: { upper } })
    const file = write("a.txt", "hello")
    expect(await formatFile(file)).toBe("upper")
    expect(fs.readFileSync(file, "utf8")).toBe("HELLO")
  })

  test("formatter: false disables every formatter", async () => {
    setConfig({ formatter: false })
    const file = write("b.txt", "hello")
    expect(await formatFile(file)).toBeUndefined()
    expect(fs.readFileSync(file, "utf8")).toBe("hello")
  })

  test("disabled: true turns a custom formatter off", async () => {
    setConfig({ formatter: { upper: { ...upper, disabled: true } } })
    const file = write("c.txt", "hello")
    expect(await formatFile(file)).toBeUndefined()
    expect(fs.readFileSync(file, "utf8")).toBe("hello")
  })

  test("unknown extension returns undefined", async () => {
    setConfig({ formatter: { upper } })
    const file = write("d.zzzunknown", "hello")
    expect(await formatFile(file)).toBeUndefined()
    expect(fs.readFileSync(file, "utf8")).toBe("hello")
  })

  test("failing formatter returns undefined and leaves the file intact", async () => {
    setConfig({ formatter: { broken: { command: [process.execPath, "-e", "process.exit(3)", "$FILE"], extensions: [".txt"] } } })
    const file = write("e.txt", "keep me")
    expect(await formatFile(file)).toBeUndefined()
    expect(fs.readFileSync(file, "utf8")).toBe("keep me")
  })
})

describe("formatterStatus", () => {
  test("lists every built-in formatter", async () => {
    setConfig({})
    const status = await formatterStatus()
    const names = status.map((s) => s.name)
    for (const builtin of BUILTIN_FORMATTERS) {
      expect(names).toContain(builtin.name)
      expect(status.find((s) => s.name === builtin.name)?.extensions).toEqual(builtin.extensions)
    }
    // No package.json, biome.json or pyproject.toml in the temp project, so these stay off.
    expect(status.find((s) => s.name === "prettier")?.enabled).toBe(false)
    expect(status.find((s) => s.name === "biome")?.enabled).toBe(false)
    expect(status.find((s) => s.name === "ruff")?.enabled).toBe(false)
  })

  test("reports everything disabled when formatter: false", async () => {
    setConfig({ formatter: false })
    const status = await formatterStatus()
    expect(status.length).toBeGreaterThan(0)
    expect(status.every((s) => s.enabled === false)).toBe(true)
  })
})
