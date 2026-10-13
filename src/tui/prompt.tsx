import React, { useEffect, useMemo, useRef, useState } from "react"
import { Box, Text, useBoxMetrics, useCursor, useInput, usePaste } from "ink"
import stringWidth from "string-width"
import * as E from "./editor"
import { fuzzyFilter } from "./fuzzy"
import { Muted, Plain } from "./view"
import type { Theme } from "./theme"

export interface Completion {
  /** Text shown in the list. */
  label: string
  description?: string
  /** Text inserted in place of the token. */
  value: string
}

export interface PromptProps {
  theme: Theme
  width: number
  /** Rows above this box in the frame, so the real cursor can be placed for IME input. */
  offsetTop: number
  agent: string
  active: boolean
  busy: boolean
  history: string[]
  commands: Completion[]
  files: () => Promise<string[]>
  onSubmit(text: string): void
  /** Run a slash command chosen from the completion list. */
  onCommand(name: string): void
  onCycleAgent(): void
  onInterrupt(): void
  onExit(): void
  /** Lets the parent replace the buffer (e.g. after `/editor`). */
  control?: React.MutableRefObject<{ set(text: string): void; get(): string } | undefined>
}

const MAX_ROWS = 10
const POPUP_ROWS = 8

export function Prompt(props: PromptProps) {
  const { theme } = props
  const [state, setState] = useState<E.EditorState>(E.empty)
  const [selected, setSelected] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const [files, setFiles] = useState<string[] | undefined>(undefined)
  const [historyIndex, setHistoryIndex] = useState<number | undefined>(undefined)
  const [armedExit, setArmedExit] = useState(false)
  const [armedInterrupt, setArmedInterrupt] = useState(false)
  const draft = useRef("")
  const stateRef = useRef(state)
  stateRef.current = state

  if (props.control) props.control.current = { set: (text) => setState({ text, cursor: text.length }), get: () => stateRef.current.text }

  const shellMode = state.text.startsWith("!")
  const inner = Math.max(10, props.width - 6) // border, padding and the "❯ " gutter
  const view = useMemo(() => E.layout(state, inner), [state, inner])
  const token = dismissed ? undefined : E.tokenAtCursor(state)

  useEffect(() => {
    if (token?.kind === "file" && files === undefined) {
      setFiles([])
      props.files().then(setFiles, () => setFiles([]))
    }
  }, [token?.kind])

  const options: Completion[] = useMemo(() => {
    if (!token) return []
    if (token.kind === "command") return fuzzyFilter(token.query, props.commands, (c) => c.label, 30)
    return fuzzyFilter(token.query, files ?? [], (f) => f, 30).map((f) => ({ label: f, value: `@${f} ` }))
  }, [token?.kind, token?.query, files, props.commands])
  const index = Math.min(selected, Math.max(0, options.length - 1))
  const popup = options.length > 0

  const update = (next: E.EditorState) => {
    setState(next)
    setSelected(0)
    setDismissed(false)
    setArmedExit(false)
  }

  const submit = (value = state.text) => {
    const text = value.trim()
    if (text === "") return
    setState(E.empty())
    setHistoryIndex(undefined)
    draft.current = ""
    props.onSubmit(text)
  }

  const accept = (run: boolean) => {
    const option = options[index]
    if (!option || !token) return
    if (token.kind === "command") {
      if (run) {
        setState(E.empty())
        props.onCommand(option.label.slice(1))
      } else update({ text: option.value, cursor: option.value.length })
      return
    }
    update(E.replaceToken(state, token.start, option.value))
  }

  const history = (direction: -1 | 1) => {
    const items = props.history
    if (items.length === 0) return
    let next: number | undefined
    if (historyIndex === undefined) {
      if (direction === 1) return
      draft.current = state.text
      next = items.length - 1
    } else {
      next = historyIndex + direction
      if (next < 0) return
      if (next >= items.length) next = undefined
    }
    setHistoryIndex(next)
    const text = next === undefined ? draft.current : items[next]!
    setState({ text, cursor: text.length })
  }

  usePaste((text) => update(E.insert(stateRef.current, text)), { isActive: props.active })

  useInput(
    (input, key) => {
      if (key.escape) {
        if (popup) return setDismissed(true)
        if (props.busy) {
          if (armedInterrupt) {
            setArmedInterrupt(false)
            props.onInterrupt()
          } else {
            setArmedInterrupt(true)
            setTimeout(() => setArmedInterrupt(false), 3000).unref?.()
          }
          return
        }
        if (state.text !== "") update(E.empty())
        return
      }
      if (key.ctrl && input === "c") {
        if (state.text !== "") return update(E.empty())
        if (armedExit) return props.onExit()
        setArmedExit(true)
        setTimeout(() => setArmedExit(false), 2500).unref?.()
        return
      }
      if (key.ctrl && input === "d") {
        if (state.text === "") return props.onExit()
        return update(E.deleteForward(state))
      }
      if (key.tab) {
        if (popup) return accept(false)
        if (!key.shift) return props.onCycleAgent()
        return
      }
      if (key.return) {
        // Shift+Enter (terminals with the kitty protocol), Alt+Enter, or a trailing backslash add a line.
        if (key.shift || key.meta) return update(E.insert(state, "\n"))
        if (state.text[state.cursor - 1] === "\\") return update(E.insert(E.backspace(state), "\n"))
        if (popup && token?.kind === "command") return accept(true)
        if (popup && token?.kind === "file") return accept(false)
        return submit()
      }
      if (input === "\n" || (key.ctrl && input === "j")) return update(E.insert(state, "\n"))
      if (key.upArrow) {
        if (popup) return setSelected((index - 1 + options.length) % options.length)
        const moved = E.vertical(state, inner, -1)
        return moved ? setState(moved) : history(-1)
      }
      if (key.downArrow) {
        if (popup) return setSelected((index + 1) % options.length)
        const moved = E.vertical(state, inner, 1)
        return moved ? setState(moved) : history(1)
      }
      if (key.leftArrow) return setState(key.meta || key.ctrl ? E.wordLeft(state) : E.left(state))
      if (key.rightArrow) return setState(key.meta || key.ctrl ? E.wordRight(state) : E.right(state))
      if (key.home || (key.ctrl && input === "a")) return setState(E.lineStart(state))
      if (key.end || (key.ctrl && input === "e")) return setState(E.lineEnd(state))
      if (key.backspace) return update(key.meta ? E.killWordBack(state) : E.backspace(state))
      if (key.delete) return update(E.deleteForward(state))
      if (key.ctrl && input === "w") return update(E.killWordBack(state))
      if (key.ctrl && input === "u") return update(E.killToLineStart(state))
      if (key.ctrl && input === "k") return update(E.killToLineEnd(state))
      if (key.ctrl && input === "b") return setState(E.left(state))
      if (key.ctrl && input === "f") return setState(E.right(state))
      if (key.meta && input === "b") return setState(E.wordLeft(state))
      if (key.meta && input === "f") return setState(E.wordRight(state))
      if (key.ctrl || key.meta || key.pageUp || key.pageDown) return
      // Several keystrokes can arrive in one chunk (fast typing, automation, terminals without
      // bracketed paste). A trailing Enter in such a chunk still means "send".
      const sends = input.length > 1 && /[\r\n]$/.test(input)
      const body = sends ? input.replace(/[\r\n]+$/, "") : input
      // Drop stray control bytes; everything printable (including IME-composed text) is inserted.
      const printable = body.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
      const next = printable !== "" ? E.insert(state, printable) : state
      if (sends) return submit(next.text)
      if (printable !== "") update(next)
    },
    { isActive: props.active },
  )

  // Scroll the editor when the buffer is taller than the box.
  const first = Math.max(0, Math.min(view.cursorRow - MAX_ROWS + 1, view.rows.length - MAX_ROWS), view.cursorRow >= MAX_ROWS ? view.cursorRow - MAX_ROWS + 1 : 0)
  const rows = view.rows.slice(first, first + MAX_ROWS)

  const popupRows = popup ? Math.min(POPUP_ROWS, options.length) : 0
  const popupStart = Math.max(0, Math.min(index - Math.floor(POPUP_ROWS / 2), options.length - POPUP_ROWS))
  const popupHeight = popup ? popupRows + 2 : 0

  // Park the real terminal cursor on the caret: IME composition (Korean, Japanese, Chinese) is drawn there.
  const boxRef = useRef(null)
  const metrics = useBoxMetrics(boxRef)
  const { setCursorPosition } = useCursor()
  if (props.active) {
    // In shell mode the leading "!" is drawn as the gutter, so the first row is one cell shorter.
    const shift = shellMode && view.cursorRow === 0 && state.cursor > 0 ? 1 : 0
    setCursorPosition({
      x: 1 + 1 + 2 + view.cursorCol - shift,
      y: props.offsetTop + (metrics.hasMeasured ? metrics.top : popupHeight) + 1 + (view.cursorRow - first),
    })
  } else setCursorPosition(undefined)

  const labelWidth = popup ? Math.min(Math.max(...options.map((o) => stringWidth(o.label))) + 2, Math.max(12, Math.floor(props.width * 0.55))) : 0
  const hint = armedExit
    ? "press ctrl+c again to exit"
    : armedInterrupt
      ? "press esc again to interrupt"
      : props.busy
        ? "esc esc to interrupt"
        : shellMode
          ? "shell mode · enter to run"
          : "enter to send · \\ + enter for a new line · tab to switch agent"

  return (
    <Box flexDirection="column" width={props.width}>
      {popup ? (
        <Box flexDirection="column" borderStyle="round" borderColor={theme.border} borderDimColor={!theme.border} paddingX={1} width={props.width}>
          {options.slice(popupStart, popupStart + POPUP_ROWS).map((option, i) => {
            const active = popupStart + i === index
            const label = option.label.length > labelWidth - 1 ? "…" + option.label.slice(-(labelWidth - 2)) : option.label
            return (
              <Text key={option.label} wrap="truncate-end">
                <Plain theme={theme} inverse={active} bold={active}>{" " + label.padEnd(labelWidth) }</Plain>
                <Muted theme={theme}>{option.description ? "  " + option.description : ""}</Muted>
              </Text>
            )
          })}
        </Box>
      ) : null}
      <Box ref={boxRef} borderStyle="round" borderColor={theme.text} paddingX={1} width={props.width} flexDirection="column">
        {rows.map((row, i) => (
          <Text key={first + i} wrap="truncate-end">
            {first + i === 0 ? <Plain theme={theme} bold>{shellMode ? "! " : "❯ "}</Plain> : <Muted theme={theme}>{"· "}</Muted>}
            {state.text === "" && i === 0 ? (
              <Muted theme={theme}>{props.busy ? "Working… type to queue your next message" : "Ask anything, or describe a change to make"}</Muted>
            ) : (
              <Plain theme={theme}>{first + i === 0 && shellMode ? row.text.slice(1) : row.text || " "}</Plain>
            )}
          </Text>
        ))}
      </Box>
      <Box paddingX={1} justifyContent="space-between" width={props.width}>
        <Text wrap="truncate-end">
          <Plain theme={theme} inverse bold>{` ${props.agent} `}</Plain>
          <Muted theme={theme}>{"  " + hint}</Muted>
        </Text>
      </Box>
    </Box>
  )
}
