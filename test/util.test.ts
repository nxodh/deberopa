import { expect, test } from "bun:test"
import { wildcardLookup, wildcardMatch } from "../src/util/wildcard"
import { createID } from "../src/util/id"
import { truncateOutput, validateArgs, coerceArgs } from "../src/tool/tool"

test("wildcard matching", () => {
  expect(wildcardMatch("git status", "git status *")).toBe(true)
  expect(wildcardMatch("git status --short", "git status *")).toBe(true)
  expect(wildcardMatch("git push", "git status *")).toBe(false)
  expect(wildcardMatch("rm -rf /", "*")).toBe(true)
  expect(wildcardMatch("src/a.ts", "src/*.ts")).toBe(true)
  expect(wildcardLookup("git push origin", { "*": "ask", "git *": "allow", "git push *": "deny" })).toBe("deny")
})

test("ids ascend", () => {
  const ids = Array.from({ length: 50 }, () => createID("message"))
  expect([...ids].sort()).toEqual(ids)
  expect(new Set(ids).size).toBe(50)
})

test("truncateOutput", () => {
  const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n")
  const head = truncateOutput(big)
  expect(head.truncated).toBe(true)
  expect(head.content.startsWith("line 0")).toBe(true)
  const tail = truncateOutput(big, { direction: "tail" })
  expect(tail.content.endsWith("line 4999")).toBe(true)
  expect(truncateOutput("short").truncated).toBe(false)
})

test("validate and coerce args", () => {
  const schema = { type: "object", required: ["path"], properties: { path: { type: "string" }, limit: { type: "number" } } }
  expect(validateArgs(schema, {})).toContain("path")
  expect(validateArgs(schema, { path: 1 })).toContain("string")
  expect(validateArgs(schema, { path: "a", limit: 3 })).toBeUndefined()
  expect(coerceArgs(schema, { path: "a", limit: "3" }).limit).toBe(3)
})
