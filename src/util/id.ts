import { randomBytes } from "node:crypto"

const prefixes = {
  session: "ses",
  message: "msg",
  part: "prt",
  permission: "per",
  call: "call",
} as const

let last = 0
let counter = 0

/** Lexicographically ascending identifiers: sorting by id sorts by creation time. */
export function createID(kind: keyof typeof prefixes): string {
  const now = Date.now()
  if (now === last) counter++
  else {
    last = now
    counter = 0
  }
  const time = now.toString(16).padStart(12, "0")
  const seq = counter.toString(16).padStart(3, "0")
  return `${prefixes[kind]}_${time}${seq}${randomBytes(6).toString("hex")}`
}
