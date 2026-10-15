"use strict"
// Runs inside the extension host of the packaged Deberopa Desktop (--extensionTestsPath).
// It checks, in the real app, that the built-in agent extension activates, starts the bundled CLI server
// for the workspace folder, opens a session and reports its model choices.
const vscode = require("vscode")
const fs = require("node:fs")

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, ms, what) {
  const end = Date.now() + ms
  let last
  while (Date.now() < end) {
    try {
      last = await fn()
      if (last) return last
    } catch (err) {
      last = err
    }
    await sleep(250)
  }
  throw new Error(`timed out waiting for ${what}${last instanceof Error ? ": " + last.message : ""}`)
}

async function run() {
  const logFile = process.env.DEBEROPA_E2E_LOG
  const log = (m) => {
    const line = "[e2e] " + new Date().toISOString() + " " + m
    console.log(line)
    if (logFile) {
      try {
        fs.appendFileSync(logFile, line + "\n")
      } catch {}
    }
  }
  let api
  const guard = setTimeout(() => {
    log("TIMEOUT: the test did not finish in 4 minutes")
    try { api && api.stop() } catch {}
    process.exit(2)
  }, 240_000)
  try {
    await body(log, (a) => { api = a })
  } finally {
    clearTimeout(guard)
    try { api && api.stop() } catch {}
  }
}

async function body(log, setApi) {
  const ext = vscode.extensions.getExtension("nxodh.deberopa-agent")
  if (!ext) throw new Error("nxodh.deberopa-agent is not installed in this app")
  log("extension found: " + ext.id + " v" + ext.packageJSON.version)
  const api = await ext.activate()
  if (!api || typeof api.ensureSession !== "function") throw new Error("the extension did not return its test api")
  setApi(api)
  log("activated; workspace " + JSON.stringify((vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath)))
  if (!vscode.workspace.workspaceFolders || !vscode.workspace.workspaceFolders.length) throw new Error("no workspace folder is open")

  const commands = await vscode.commands.getCommands(true)
  for (const id of ["deberopa.focus", "deberopa.newSession", "deberopa.abort", "deberopa.restartServer", "deberopa.addSelection", "deberopa.addFile"]) {
    if (!commands.includes(id)) throw new Error("command is not registered: " + id)
  }
  log("commands registered")

  await api.ensureSession()
  const first = api.status()
  if (!first.running || !first.sessionID) throw new Error("the agent server did not start: " + JSON.stringify(first))
  log("server up, session " + first.sessionID + ", " + first.models + " model(s), " + first.agents + " agent(s)")

  await vscode.commands.executeCommand("deberopa.newSession")
  const second = await waitFor(() => {
    const s = api.status()
    return s.sessionID && s.sessionID !== first.sessionID ? s : undefined
  }, 15000, "a new session")
  log("new session " + second.sessionID)

  await vscode.commands.executeCommand("deberopa.restartServer")
  const third = await waitFor(() => {
    const s = api.status()
    return s.running && s.sessionID ? s : undefined
  }, 60000, "the server to restart")
  log("restarted, session " + third.sessionID)

  // the panel's view provider is registered and the view can be revealed without error
  await vscode.commands.executeCommand("deberopa.focus")
  log("OK")
}

module.exports = { run }
