import { afterAll, beforeEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// A directory with no executables on PATH, so "gopls is missing" holds on any machine.
const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), "vdc-nobin-"))
const originalPath = process.env.PATH
process.env.PATH = emptyBin

const { INSTALLERS, installedCommand, installDir } = await import("../src/lsp/install")
const lsp = await import("../src/lsp")
const { endProject, tmpDir, useProject } = await import("./helpers")

const gopls = INSTALLERS.find((i) => i.id === "gopls")!
const real = { requires: gopls.requires, install: gopls.install }
let installs = 0
let proj: string

beforeEach(() => {
  proj = tmpDir()
  fs.writeFileSync(path.join(proj, "go.mod"), "module x\n")
  fs.writeFileSync(path.join(proj, "main.go"), "package main\n")
  useProject(proj, { snapshot: false })
  gopls.requires = undefined // the real installer needs `go`; the fake below needs nothing
  gopls.install = async (dir) => {
    installs++
    fs.mkdirSync(path.join(dir, "bin"), { recursive: true })
    fs.writeFileSync(gopls.command(dir)[0]!, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  }
  fs.rmSync(installDir("gopls"), { recursive: true, force: true })
  installs = 0
  lsp.resetInstallOffers()
})
afterAll(() => {
  Object.assign(gopls, real)
  process.env.PATH = originalPath
  fs.rmSync(emptyBin, { recursive: true, force: true })
  endProject()
})

const prompt = (answer: "yes" | "no", log: any[] = []) => ({
  ask: async (r: any) => {
    log.push(r)
    if (answer === "no") throw new Error("rejected")
  },
})

test("a missing server is offered, installed on consent, and then resolvable", async () => {
  expect(await lsp.resolveServer("gopls", proj)).toBeUndefined()
  const log: any[] = []
  const note = await lsp.offerInstall(path.join(proj, "main.go"), prompt("yes", log))
  expect(note).toBeUndefined()
  expect(installs).toBe(1)
  expect(log).toHaveLength(1)
  expect(log[0]).toMatchObject({ permission: "lsp_install", patterns: ["gopls"] })
  expect(log[0].title).toContain("gopls")
  expect(await installedCommand("gopls")).toBeTruthy()
  expect((await lsp.resolveServer("gopls", proj))![0]).toContain(path.join("lsp", "gopls"))
})

test("declining installs nothing, and the question is not repeated", async () => {
  const log: any[] = []
  await lsp.offerInstall(path.join(proj, "main.go"), prompt("no", log))
  await lsp.offerInstall(path.join(proj, "main.go"), prompt("no", log))
  expect(installs).toBe(0)
  expect(log).toHaveLength(1)
  expect(await installedCommand("gopls")).toBeUndefined()
})

test("a failing installer is reported in one line and does not throw", async () => {
  const ts = INSTALLERS.find((i) => i.id === "typescript")!
  const saved = { requires: ts.requires, install: ts.install }
  ts.requires = undefined
  ts.install = async () => {
    throw new Error("npm install failed:\nE404 not found")
  }
  try {
    fs.writeFileSync(path.join(proj, "package.json"), "{}")
    fs.writeFileSync(path.join(proj, "a.ts"), "export {}\n")
    const note = await lsp.offerInstall(path.join(proj, "a.ts"), prompt("yes"))
    expect(note).toContain("Could not install")
    expect(note).toContain("npm install failed")
    expect(note).not.toContain("E404") // only the first line
  } finally {
    Object.assign(ts, saved)
  }
})

test("no offer when LSP or installation is switched off, or the language is unknown", async () => {
  const log: any[] = []
  useProject(proj, { snapshot: false, lsp_install: false })
  expect(await lsp.offerInstall(path.join(proj, "main.go"), prompt("yes", log))).toBeUndefined()
  useProject(proj, { snapshot: false, lsp: false })
  expect(await lsp.offerInstall(path.join(proj, "main.go"), prompt("yes", log))).toBeUndefined()
  useProject(proj, { snapshot: false })
  fs.writeFileSync(path.join(proj, "notes.xyz"), "x")
  expect(await lsp.offerInstall(path.join(proj, "notes.xyz"), prompt("yes", log))).toBeUndefined()
  expect(log).toHaveLength(0)
  expect(installs).toBe(0)
})
