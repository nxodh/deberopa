import React, { useEffect, useRef, useState } from "react"
import { Box, useBoxMetrics, useInput } from "ink"
import { boundAction, DEFAULT_KEYBINDS, type KeyAction } from "./keybinds"
import { Muted } from "./view"
import type { Theme } from "./theme"

/** A bounded conversation viewport. Undefined offset follows new output at the bottom. */
export function Conversation(props: {
  width: number
  theme: Theme
  active: boolean
  keybinds?: Record<string, string>
  followID?: string
  children: React.ReactNode
}) {
  const viewport = useRef(null)
  const content = useRef(null)
  const view = useBoxMetrics(viewport)
  const body = useBoxMetrics(content)
  const [requested, setRequested] = useState<number>()
  const max = Math.max(0, body.height - view.clientHeight)
  const offset = requested === undefined ? max : Math.min(requested, max)
  const label = (action: KeyAction) => (props.keybinds?.[action] ?? DEFAULT_KEYBINDS[action]).replace(/pageup/gi, "PgUp").replace(/pagedown/gi, "PgDn")

  useEffect(() => setRequested(undefined), [props.followID])
  useInput((input, key) => {
    const bound = (action: "scroll_up" | "scroll_down" | "scroll_top" | "scroll_bottom") => boundAction(action, props.keybinds, input, key)
    const page = Math.max(1, view.clientHeight - 1)
    if (bound("scroll_top")) return setRequested(0)
    if (bound("scroll_bottom")) return setRequested(undefined)
    if (bound("scroll_up")) return setRequested(Math.max(0, offset - page))
    if (bound("scroll_down")) {
      const next = Math.min(max, offset + page)
      setRequested(next === max ? undefined : next)
    }
  }, { isActive: props.active })

  return (
    <Box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0}>
      <Box ref={viewport} flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden" contentOffsetY={offset} flexDirection="column">
        <Box ref={content} width={props.width} flexDirection="column" flexShrink={0}>
          {props.children}
        </Box>
      </Box>
      <Box height={1} flexShrink={0} paddingX={1}>
        <Muted theme={props.theme} wrap="truncate-end">
          {max > 0 ? offset < max ? `↑ history · ${max - offset} rows below · ${label("scroll_down")} / ${label("scroll_bottom")} to return` : `${label("scroll_up")} / ${label("scroll_down")} to scroll · ${label("scroll_top")} / ${label("scroll_bottom")}` : " "}
        </Muted>
      </Box>
    </Box>
  )
}
