import fs from "node:fs"
import path from "node:path"
import { Paths } from "../global"

let stream: fs.WriteStream | undefined
let printToStderr = false

export function initLog(opts: { print?: boolean } = {}) {
  printToStderr = !!opts.print
  try {
    fs.mkdirSync(Paths.log, { recursive: true })
    const files = fs.readdirSync(Paths.log).filter((f) => f.endsWith(".log")).sort()
    for (const old of files.slice(0, Math.max(0, files.length - 9))) fs.rmSync(path.join(Paths.log, old), { force: true })
    const name = new Date().toISOString().replace(/[:.]/g, "-") + ".log"
    stream = fs.createWriteStream(path.join(Paths.log, name), { flags: "a" })
    stream.on("error", () => (stream = undefined))
  } catch {
    stream = undefined
  }
}

function write(level: string, service: string, message: string, extra?: unknown) {
  let tail = ""
  if (extra !== undefined) {
    try {
      tail = " " + (extra instanceof Error ? extra.stack || extra.message : JSON.stringify(extra))
    } catch {
      tail = " [unserializable]"
    }
  }
  const line = `${new Date().toISOString()} ${level.padEnd(5)} ${service} ${message}${tail}\n`
  stream?.write(line)
  if (printToStderr) process.stderr.write(line)
}

export function createLogger(service: string) {
  return {
    debug: (m: string, e?: unknown) => write("DEBUG", service, m, e),
    info: (m: string, e?: unknown) => write("INFO", service, m, e),
    warn: (m: string, e?: unknown) => write("WARN", service, m, e),
    error: (m: string, e?: unknown) => write("ERROR", service, m, e),
  }
}
