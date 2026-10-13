// Minimal stdio LSP server for test/lsp.test.ts. Content-Length framed JSON-RPC on stdin/stdout.
// Publishes an error per line containing ERROR and a warning per line containing WARN.
import fs from "node:fs"

// Lets the test check that no process survives shutdown.
const pidFile = process.env.FAKE_LSP_PID_FILE
if (pidFile) fs.writeFileSync(pidFile, String(process.pid))

function send(msg: unknown) {
  const body = Buffer.from(JSON.stringify(msg), "utf8")
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]))
}

function publish(uri: string, version: number | undefined, text: string) {
  const diagnostics: unknown[] = []
  text.split("\n").forEach((line, i) => {
    const range = { start: { line: i, character: 0 }, end: { line: i, character: line.length } }
    if (line.includes("ERROR")) diagnostics.push({ range, severity: 1, message: "found ERROR", source: "fake" })
    if (line.includes("WARN")) diagnostics.push({ range, severity: 2, message: "found WARN", source: "fake" })
  })
  send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, version, diagnostics } })
}

function handle(msg: any) {
  const { id, method, params } = msg
  switch (method) {
    case "initialize":
      return send({ jsonrpc: "2.0", id, result: { capabilities: { textDocumentSync: 1 }, serverInfo: { name: "fake-lsp" } } })
    case "textDocument/didOpen":
      return publish(params.textDocument.uri, params.textDocument.version, params.textDocument.text)
    case "textDocument/didChange": {
      const change = params.contentChanges[params.contentChanges.length - 1]
      return publish(params.textDocument.uri, params.textDocument.version, change.text)
    }
    case "shutdown":
      return send({ jsonrpc: "2.0", id, result: null })
    case "exit":
      process.exit(0)
      return
    default:
      // Unknown requests get an empty answer so the client never waits on them.
      if (id !== undefined) send({ jsonrpc: "2.0", id, result: null })
  }
}

let buf = Buffer.alloc(0)
process.stdin.on("data", (chunk: Buffer) => {
  buf = Buffer.concat([buf, chunk])
  for (;;) {
    const sep = buf.indexOf("\r\n\r\n")
    if (sep === -1) return
    const match = /Content-Length:\s*(\d+)/i.exec(buf.toString("ascii", 0, sep))
    const start = sep + 4
    const length = Number(match?.[1] ?? 0)
    if (buf.length < start + length) return
    const body = buf.toString("utf8", start, start + length)
    buf = buf.subarray(start + length)
    handle(JSON.parse(body))
  }
})
// Exit when the client goes away so nothing is left behind.
process.stdin.on("end", () => process.exit(0))
