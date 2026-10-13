import { createID } from "../util/id"
import { publish } from "../util/bus"
import { wildcardMatch } from "../util/wildcard"
import { PermissionDeniedError, type PermissionRequest } from "../tool/tool"
import type { PermissionAction, PermissionConfig } from "../config/config"

/** permission key → pattern → action. Later patterns win. */
export type Ruleset = Record<string, Record<string, PermissionAction>>

export const DEFAULT_RULES: Ruleset = {
  "*": { "*": "allow" },
  external_directory: { "*": "ask" },
  doom_loop: { "*": "ask" },
  read: { "*": "allow", "*.env": "ask", "*.env.*": "ask", "*.env.example": "allow", "*.env.sample": "allow" },
}

export function toRuleset(config: PermissionConfig | undefined): Ruleset {
  if (!config) return {}
  if (typeof config === "string") return { "*": { "*": config } }
  const out: Ruleset = {}
  for (const [key, rule] of Object.entries(config)) {
    out[key] = typeof rule === "string" ? { "*": rule } : { ...rule }
  }
  return out
}

/** Later rulesets override earlier ones key by key; patterns within a key are appended. */
export function mergeRulesets(...sets: Ruleset[]): Ruleset {
  const out: Ruleset = {}
  for (const set of sets) {
    for (const [key, rules] of Object.entries(set)) {
      // A blanket rule for a key replaces what came before rather than being shadowed by older patterns.
      if (Object.keys(rules).length === 1 && "*" in rules) out[key] = { ...rules }
      else out[key] = { ...out[key], ...rules }
    }
  }
  return out
}

export function evaluate(ruleset: Ruleset, permission: string, pattern: string): PermissionAction {
  const rules = ruleset[permission] ?? ruleset["*"]
  if (!rules) return "ask"
  let result: PermissionAction | undefined
  for (const [rule, action] of Object.entries(rules)) {
    if (wildcardMatch(pattern, rule)) result = action
  }
  return result ?? ruleset["*"]?.["*"] ?? "ask"
}

/** A tool is removed from the model's toolbox when its permission is denied outright. */
export function isDisabled(ruleset: Ruleset, permission: string): boolean {
  const rules = ruleset[permission] ?? ruleset["*"]
  if (!rules) return false
  const actions = Object.values(rules)
  return actions.length > 0 && actions.every((a) => a === "deny")
}

export interface PendingPermission {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  always: string[]
  title: string
  metadata: Record<string, unknown>
  time: number
}

export type PermissionReply = "once" | "always" | "reject"

const pending = new Map<string, { info: PendingPermission; resolve: () => void; reject: (err: Error) => void }>()
/** Patterns the user approved with "always", per session (children inherit from their root). */
const approved = new Map<string, Ruleset>()

export function pendingPermissions(): PendingPermission[] {
  return [...pending.values()].map((p) => p.info).sort((a, b) => a.time - b.time)
}

export async function askPermission(input: PermissionRequest & { sessionID: string; ruleset: Ruleset; approvalScope?: string }): Promise<void> {
  const scope = input.approvalScope ?? input.sessionID
  const session = approved.get(scope) ?? {}
  let needsAsk = false
  for (const pattern of input.patterns.length ? input.patterns : ["*"]) {
    const action = evaluate(input.ruleset, input.permission, pattern)
    if (action === "deny") {
      throw new PermissionDeniedError(
        `Permission denied by configuration: ${input.permission} is not allowed for "${pattern}". Do not retry; tell the user or choose another approach.`,
      )
    }
    if (action === "ask") {
      const remembered = Object.keys(session[input.permission] ?? {}).some((rule) => wildcardMatch(pattern, rule))
      if (!remembered) needsAsk = true
    }
  }
  if (!needsAsk) return

  const info: PendingPermission = {
    id: createID("permission"),
    sessionID: input.sessionID,
    permission: input.permission,
    patterns: input.patterns,
    always: input.always ?? input.patterns,
    title: input.title,
    metadata: input.metadata ?? {},
    time: Date.now(),
  }
  return new Promise<void>((resolve, reject) => {
    pending.set(info.id, {
      info,
      resolve: () => {
        resolve()
      },
      reject,
    })
    ;(pending.get(info.id) as any).scope = scope
    publish("permission.asked", info)
  })
}

export function replyPermission(id: string, reply: PermissionReply, message?: string) {
  const entry = pending.get(id)
  if (!entry) return false
  pending.delete(id)
  const scope: string = (entry as any).scope ?? entry.info.sessionID
  publish("permission.replied", { id, sessionID: entry.info.sessionID, reply })
  if (reply === "reject") {
    const error = new PermissionDeniedError(
      message
        ? `The user rejected this tool call with the following feedback: ${message}`
        : "The user rejected permission to use this specific tool call. Do not retry it; ask how they would like to proceed.",
    )
    // A plain rejection halts the turn so the user can redirect; feedback lets the model carry on with it.
    error.byUser = !message
    entry.reject(error)
    return true
  }
  if (reply === "always") {
    const rules = approved.get(scope) ?? {}
    rules[entry.info.permission] = { ...rules[entry.info.permission] }
    for (const pattern of entry.info.always) rules[entry.info.permission]![pattern] = "allow"
    approved.set(scope, rules)
    // Anything else already waiting on the same approval can go ahead too.
    for (const [otherID, other] of [...pending]) {
      if (((other as any).scope ?? other.info.sessionID) !== scope || other.info.permission !== entry.info.permission) continue
      const covered = other.info.patterns.every((p) => entry.info.always.some((rule) => wildcardMatch(p, rule)))
      if (covered) {
        pending.delete(otherID)
        publish("permission.replied", { id: otherID, sessionID: other.info.sessionID, reply: "always" })
        other.resolve()
      }
    }
  }
  entry.resolve()
  return true
}

/** Reject everything still waiting for a session (used when the run is cancelled). */
export function rejectPending(sessionID: string) {
  for (const [id, entry] of [...pending]) {
    if (entry.info.sessionID !== sessionID) continue
    pending.delete(id)
    publish("permission.replied", { id, sessionID, reply: "reject" })
    entry.reject(new PermissionDeniedError("The request was cancelled."))
  }
}
