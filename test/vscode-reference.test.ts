import { expect, test } from "bun:test"
import { formatReference, relativeTo, toPosix } from "../ide/vscode/src/reference"
import { splitLineRange } from "../src/session/prompt"

const sel = (startLine: number, endLine: number, over: Partial<{ endAtLineStart: boolean; isEmpty: boolean }> = {}) => ({
  startLine,
  endLine,
  endAtLineStart: false,
  isEmpty: false,
  ...over,
})

test("references use 1-based inclusive line ranges", () => {
  expect(formatReference("src/a.ts")).toBe("@src/a.ts ")
  expect(formatReference("src/a.ts", sel(9, 9, { isEmpty: true }))).toBe("@src/a.ts ")
  expect(formatReference("src/a.ts", sel(9, 9))).toBe("@src/a.ts#L10 ")
  expect(formatReference("src/a.ts", sel(9, 19))).toBe("@src/a.ts#L10-20 ")
  // shift+down leaves the caret at column 0 of the next line, which is not part of the selection
  expect(formatReference("src/a.ts", sel(9, 20, { endAtLineStart: true }))).toBe("@src/a.ts#L10-20 ")
  expect(formatReference("src/a.ts", sel(9, 9, { endAtLineStart: true }))).toBe("@src/a.ts#L10 ")
})

test("Windows separators become forward slashes; unmentionable paths are refused", () => {
  expect(toPosix("src\\ui\\a.ts")).toBe("src/ui/a.ts")
  expect(formatReference("src\\ui\\a.ts", sel(0, 1))).toBe("@src/ui/a.ts#L1-2 ")
  expect(formatReference("my docs/a.ts")).toBeUndefined()
  expect(formatReference("a,b.ts")).toBeUndefined()
})

test("paths are made relative to the workspace folder only when inside it", () => {
  expect(relativeTo("/work/app", "/work/app/src/a.ts")).toBe("src/a.ts")
  expect(relativeTo("/work/app", "/work/application/a.ts")).toBe("/work/application/a.ts")
  expect(relativeTo("/work/app/", "/work/app/a.ts")).toBe("a.ts")
  expect(relativeTo("C:\\Work\\App", "c:\\work\\app\\src\\a.ts")).toBe("src/a.ts")
  expect(relativeTo(undefined, "/x/y.ts")).toBe("/x/y.ts")
})

test("the prompt parses what the extension writes", () => {
  expect(splitLineRange("src/a.ts#L10-20")).toEqual({ target: "src/a.ts", start: 10, end: 20 })
  expect(splitLineRange("src/a.ts#L7")).toEqual({ target: "src/a.ts", start: 7, end: 7 })
  expect(splitLineRange("src/a.ts#L20-L10")).toEqual({ target: "src/a.ts", start: 10, end: 20 })
  expect(splitLineRange("src/a.ts")).toEqual({ target: "src/a.ts" })
  expect(splitLineRange("weird#name.ts")).toEqual({ target: "weird#name.ts" })
})
