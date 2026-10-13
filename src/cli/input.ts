import readline from "node:readline"

/** Read all of stdin. Resolves "" quickly when nothing is being piped in. */
export async function readStdin(opts: { firstByteTimeoutMs?: number } = {}): Promise<string> {
  if (process.stdin.isTTY) return ""
  return new Promise<string>((resolve) => {
    let data = ""
    let started = false
    const finish = () => {
      clearTimeout(timer)
      process.stdin.removeAllListeners("data")
      process.stdin.removeAllListeners("end")
      process.stdin.pause()
      resolve(data)
    }
    const timer = setTimeout(() => {
      if (!started) finish()
    }, opts.firstByteTimeoutMs ?? 1500)
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (chunk) => {
      started = true
      data += chunk
    })
    process.stdin.on("end", finish)
    process.stdin.on("error", finish)
    process.stdin.resume()
  })
}

/** Ask a question on the terminal. With `mask`, typed characters are shown as `*`. Falls back to a plain line read when stdin is not a TTY. */
export function ask(question: string, opts: { mask?: boolean } = {}): Promise<string> {
  if (!process.stdin.isTTY || !opts.mask) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: !!process.stdin.isTTY })
    return new Promise((resolve) => {
      let answered = false
      rl.question(question, (answer) => {
        answered = true
        rl.close()
        resolve(answer.trim())
      })
      rl.on("close", () => {
        if (!answered) resolve("")
      })
    })
  }
  return new Promise((resolve, reject) => {
    process.stderr.write(question)
    let value = ""
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding("utf8")
    const done = (err?: Error) => {
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stdin.removeListener("data", onData)
      process.stderr.write("\n")
      if (err) reject(err)
      else resolve(value.trim())
    }
    const onData = (chunk: string) => {
      // A paste arrives as one chunk, so walk it character by character.
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done()
        if (ch === "\u0003") return done(new Error("Cancelled"))
        if (ch === "\u007f" || ch === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1)
            process.stderr.write("\b \b")
          }
        } else if (ch >= " ") {
          value += ch
          process.stderr.write("*")
        }
      }
    }
    process.stdin.on("data", onData)
  })
}

/** Numbered menu. Returns the chosen value. */
export async function choose<T extends string>(title: string, items: { value: T; label: string }[]): Promise<T | undefined> {
  process.stderr.write(`${title}\n`)
  items.forEach((item, i) => process.stderr.write(`  ${String(i + 1).padStart(2)}. ${item.label}\n`))
  const answer = await ask("Choose a number (or press Enter to cancel): ")
  const n = Number(answer)
  return Number.isInteger(n) && n >= 1 && n <= items.length ? items[n - 1]!.value : undefined
}
