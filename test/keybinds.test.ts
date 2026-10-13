import { expect, test } from "bun:test"
import { boundAction, matchesBinding } from "../src/tui/keybinds"

test("modifiers and special keys stay distinct", () => {
  expect(matchesBinding("enter", "", { return: true })).toBe(true)
  expect(matchesBinding("enter", "", { return: true, shift: true })).toBe(false)
  expect(matchesBinding("alt+enter", "", { return: true, meta: true })).toBe(true)
  expect(matchesBinding("ctrl+j", "\n", {})).toBe(true)
  expect(matchesBinding("none", "", { return: true })).toBe(false)
})
test("a user binding takes precedence over conflicting defaults", () => {
  const config = { submit: "ctrl+j" }
  expect(boundAction("submit", config, "j", { ctrl: true })).toBe(true)
  expect(boundAction("newline", config, "j", { ctrl: true })).toBe(false)
  expect(boundAction("submit", config, "", { return: true })).toBe(false)
})
