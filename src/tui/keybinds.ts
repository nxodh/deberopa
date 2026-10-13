export const DEFAULT_KEYBINDS = {
  interrupt: "escape", clear_exit: "ctrl+c", quit: "ctrl+d", agent_next: "tab",
  submit: "enter", newline: "shift+enter,alt+enter,ctrl+j",
  up: "up", down: "down", left: "left,ctrl+b", right: "right,ctrl+f",
  word_left: "ctrl+left,alt+left,alt+b", word_right: "ctrl+right,alt+right,alt+f",
  line_start: "home,ctrl+a", line_end: "end,ctrl+e",
  backspace: "backspace", delete: "delete", delete_word: "ctrl+w,alt+backspace",
  delete_line_start: "ctrl+u", delete_line_end: "ctrl+k",
  models: "none", sessions: "none", new_session: "none", help: "none", editor: "none",
  scroll_up: "pageup", scroll_down: "pagedown", scroll_top: "ctrl+home", scroll_bottom: "ctrl+end",
} as const

export type KeyAction = keyof typeof DEFAULT_KEYBINDS
export interface InputKey {
  ctrl?: boolean; meta?: boolean; shift?: boolean
  return?: boolean; escape?: boolean; tab?: boolean; backspace?: boolean; delete?: boolean
  upArrow?: boolean; downArrow?: boolean; leftArrow?: boolean; rightArrow?: boolean
  home?: boolean; end?: boolean
  pageUp?: boolean; pageDown?: boolean
}

const aliases: Record<string, string> = { return: "enter", esc: "escape", meta: "alt", option: "alt", control: "ctrl", space: " " }
const names: [keyof InputKey, string][] = [
  ["return", "enter"], ["escape", "escape"], ["tab", "tab"], ["backspace", "backspace"], ["delete", "delete"],
  ["upArrow", "up"], ["downArrow", "down"], ["leftArrow", "left"], ["rightArrow", "right"], ["home", "home"], ["end", "end"],
  ["pageUp", "pageup"], ["pageDown", "pagedown"],
]

export function matchesBinding(binding: string, input: string, key: InputKey): boolean {
  if (typeof binding !== "string") return false
  const name = names.find(([flag]) => key[flag])?.[1] ?? input.toLowerCase()
  return binding.toLowerCase().split(",").some((alternative) => {
    const parts = alternative.trim().split("+").map((p) => aliases[p.trim()] ?? p.trim())
    const target = parts.pop()
    if (!target || target === "none") return false
    // Some terminals report Ctrl+J as a raw LF rather than a modified letter.
    if (target === "j" && parts.includes("ctrl") && input === "\n" && !key.return) return true
    return target === name && !!key.ctrl === parts.includes("ctrl") && !!key.meta === parts.includes("alt") &&
      !!key.shift === parts.includes("shift") &&
      parts.every((p) => ["ctrl", "alt", "shift"].includes(p))
  })
}

export function boundAction(action: KeyAction, config: Record<string, string> | undefined, input: string, key: InputKey): boolean {
  const configured = typeof config?.[action] === "string" ? config[action] : undefined
  if (configured === undefined && Object.entries(config ?? {}).some(([other, binding]) => other !== action && other in DEFAULT_KEYBINDS && matchesBinding(binding, input, key))) return false
  return matchesBinding(configured ?? DEFAULT_KEYBINDS[action], input, key)
}
