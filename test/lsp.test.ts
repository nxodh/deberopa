import { afterAll, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// Must run before any project module loads: global.ts resolves its paths at import time.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "vedecaps-lsp-home-"))
process.env.VEDECAPS_HOME = home
delete process.env.VEDECAPS_CONFIG_CONTENT // a previous test file may have left one behind

const { createLspClient, createMessageDecoder, encodeMessage, diagnosticKey } = await import("../src/lsp/client")
const { touchFile, formatDiagnostics, lspStatus, shutdownLsp } = await import("../src/lsp/index")
const { initProject } = await import("../src/project")
const { resetConfig } = await import("../src/config/config")

const fixture = path.join(import.meta.dir, "fixtures", "fake-lsp-server.ts")
const created: string[] = []

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  created.push(dir)
  return dir
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

afterAll(async () => {
  await shutdownLsp()
  for (const dir of [...created, home]) fs.rmSync(dir, { recursive: true, force: true })
})

test("decoder: split chunks, coalesced messages and multi-byte bodies", () => {
  const got: unknown[] = []
  const decoder = createMessageDecoder((msg) => got.push(msg))
  const first = { id: 1, text: "한국어 😀 ERROR" }
  const second = { id: 2, method: "textDocument/publishDiagnostics" }
  const wire = Buffer.concat([encodeMessage(first), encodeMessage(second)])

  // Content-Length counts bytes, not characters.
  const header = encodeMessage(first).toString("ascii", 0, encodeMessage(first).indexOf("\r\n\r\n"))
  expect(header).toBe(`Content-Length: ${Buffer.byteLength(JSON.stringify(first), "utf8")}`)

  // One byte at a time splits every header and multi-byte character.
  for (let i = 0; i < wire.length; i++) decoder.feed(wire.subarray(i, i + 1))
  expect(got).toEqual([first, second])

  // Both messages in one chunk.
  got.length = 0
  decoder.feed(wire)
  expect(got).toEqual([first, second])

  // A cut inside a multi-byte character, then the rest.
  got.length = 0
  const cut = encodeMessage(first).indexOf(Buffer.from("한")) + 1
  const single = encodeMessage(first)
  decoder.feed(single.subarray(0, cut))
  expect(got).toEqual([])
  decoder.feed(single.subarray(cut))
  expect(got).toEqual([first])
})

test("client: diagnostics follow the file on disk, and shutdown leaves no process", async () => {
  const dir = tempDir("vedecaps-lsp-client-")
  const file = path.join(dir, "sample.fake")
  const pidFile = path.join(dir, "pid")
  fs.writeFileSync(file, "const a = 1\nERROR broken here\n")

  const client = await createLspClient({
    serverID: "fake",
    command: [process.execPath, fixture],
    root: dir,
    env: { FAKE_LSP_PID_FILE: pidFile },
  })
  const key = diagnosticKey(file)
  try {
    expect(client.serverID).toBe("fake")
    expect(client.alive).toBe(true)

    await client.notifyFile(file)
    await client.waitForDiagnostics(file)
    const errors = client.diagnostics().get(key)
    expect(errors).toHaveLength(1)
    expect(errors?.[0]).toMatchObject({ severity: 1, message: "found ERROR", range: { start: { line: 1, character: 0 } } })

    fs.writeFileSync(file, "const a = 2\n")
    await client.notifyFile(file)
    await client.waitForDiagnostics(file)
    expect(client.diagnostics().get(key)).toEqual([])
  } finally {
    await client.shutdown()
  }

  expect(client.alive).toBe(false)
  const pid = Number(fs.readFileSync(pidFile, "utf8"))
  expect(isAlive(pid)).toBe(false)
  // After shutdown, calls are no-ops rather than throws.
  await client.notifyFile(file)
}, 20000)

test("client: a server that exits during the handshake rejects", async () => {
  await expect(
    createLspClient({ serverID: "dead", command: [process.execPath, "-e", "process.exit(3)"], root: tempDir("vedecaps-lsp-dead-") }),
  ).rejects.toThrow()
}, 20000)

test("index: touchFile reports errors through a custom server from vedecaps.json", async () => {
  const dir = tempDir("vedecaps-lsp-project-")
  fs.writeFileSync(
    path.join(dir, "vedecaps.json"),
    JSON.stringify({ lsp: { fake: { command: [process.execPath, fixture], extensions: [".fake"] } } }),
  )
  const file = path.join(dir, "sample.fake")
  fs.writeFileSync(file, "ERROR first line\nWARN second line\nfine\n")

  initProject(dir)
  resetConfig()
  await touchFile(file, true)

  expect(await lspStatus()).toEqual([{ id: "fake", root: dir, connected: true }])
  const out = formatDiagnostics(file)
  expect(out).toContain("ERROR [1:1] found ERROR")
  expect(out).not.toContain("WARN")
  expect(out.split("\n")).toHaveLength(1)
}, 20000)

test("index: lsp false makes touchFile a no-op", async () => {
  await shutdownLsp()
  const dir = tempDir("vedecaps-lsp-disabled-")
  fs.writeFileSync(path.join(dir, "vedecaps.json"), JSON.stringify({ lsp: false }))
  const file = path.join(dir, "sample.fake")
  fs.writeFileSync(file, "ERROR here\n")

  initProject(dir)
  resetConfig()
  await touchFile(file, true)

  expect(formatDiagnostics(file)).toBe("")
  expect(await lspStatus()).toEqual([])
}, 20000)
