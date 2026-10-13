import React, { useMemo, useState } from "react"
import { Box, Text, useInput, usePaste } from "ink"
import stringWidth from "string-width"
import { fuzzyFilter } from "./fuzzy"
import { Lines, Muted, Plain } from "./view"
import { renderMarkdown } from "./markdown"
import type { Theme } from "./theme"
import type { PendingPermission, PermissionReply } from "../permission/permission"

export interface SelectItem<T = string> {
  value: T
  label: string
  hint?: string
  /** Items with the same group are listed together under that heading. */
  group?: string
}

function Frame(props: { theme: Theme; width: number; title: string; footer: string; children: React.ReactNode }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={props.theme.text} paddingX={1} width={props.width}>
      <Box justifyContent="space-between">
        <Plain theme={props.theme} bold>{props.title}</Plain>
        <Muted theme={props.theme}>{props.footer}</Muted>
      </Box>
      {props.children}
    </Box>
  )
}

/** Filterable list. Type to narrow, arrows to move, Enter to choose, Esc to close. */
export function SelectDialog<T>(props: {
  theme: Theme
  width: number
  title: string
  items: SelectItem<T>[]
  current?: T
  rows?: number
  empty?: string
  onSelect(value: T): void
  onCancel(): void
  /** Optional secondary action on the highlighted item (shown in the footer). */
  action?: { key: string; label: string; run(value: T): void }
}) {
  const { theme } = props
  const [query, setQuery] = useState("")
  const [cursor, setCursor] = useState(() => Math.max(0, props.items.findIndex((i) => i.value === props.current)))
  const filtered = useMemo(
    () => (query === "" ? props.items : fuzzyFilter(query, props.items, (i) => `${i.label} ${i.group ?? ""} ${i.hint ?? ""}`, 500)),
    [query, props.items],
  )
  const index = Math.min(cursor, Math.max(0, filtered.length - 1))
  const visible = props.rows ?? 12
  const start = Math.max(0, Math.min(index - Math.floor(visible / 2), filtered.length - visible))
  const slice = filtered.slice(start, start + visible)

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) return props.onCancel()
    if (key.return) {
      const item = filtered[index]
      if (item) props.onSelect(item.value)
      return
    }
    if (key.upArrow || (key.ctrl && input === "p")) return setCursor((index - 1 + filtered.length) % Math.max(1, filtered.length))
    if (key.downArrow || (key.ctrl && input === "n")) return setCursor((index + 1) % Math.max(1, filtered.length))
    if (key.pageUp) return setCursor(Math.max(0, index - visible))
    if (key.pageDown) return setCursor(Math.min(filtered.length - 1, index + visible))
    if (props.action && key.ctrl && input === props.action.key) {
      const item = filtered[index]
      if (item) props.action.run(item.value)
      return
    }
    if (key.backspace || key.delete) {
      setQuery((q) => [...q].slice(0, -1).join(""))
      return setCursor(0)
    }
    if (key.ctrl || key.meta || key.tab) return
    const printable = input.replace(/[\u0000-\u001f\u007f]/g, "")
    if (printable) {
      setQuery((q) => q + printable)
      setCursor(0)
    }
  })

  const labelWidth = Math.min(Math.max(8, ...slice.map((i) => stringWidth(i.label))) + 1, Math.floor(props.width * 0.6))
  let lastGroup: string | undefined
  return (
    <Frame theme={theme} width={props.width} title={props.title} footer={`${props.action ? `ctrl+${props.action.key} ${props.action.label} · ` : ""}esc to close`}>
      <Text>
        <Muted theme={theme}>{"/ "}</Muted>
        <Plain theme={theme}>{query}</Plain>
        <Plain theme={theme} inverse>{" "}</Plain>
        {query === "" ? <Muted theme={theme}>{" type to filter"}</Muted> : null}
      </Text>
      {filtered.length === 0 ? <Muted theme={theme}>{props.empty ?? "No matches"}</Muted> : null}
      {slice.map((item, i) => {
        const active = start + i === index
        const heading = query === "" && item.group !== lastGroup ? item.group : undefined
        lastGroup = item.group
        return (
          <Box key={start + i} flexDirection="column">
            {heading ? <Muted theme={theme} bold>{heading}</Muted> : null}
            <Text wrap="truncate-end">
              <Plain theme={theme} inverse={active} bold={active}>{` ${item.value === props.current ? "●" : " "} ${item.label}${" ".repeat(Math.max(0, labelWidth - stringWidth(item.label)))}`}</Plain>
              <Muted theme={theme}>{item.hint ? "  " + item.hint : ""}</Muted>
            </Text>
          </Box>
        )
      })}
      {filtered.length > visible ? <Muted theme={theme}>{`${index + 1}/${filtered.length}`}</Muted> : null}
    </Frame>
  )
}

/** Single-line text entry, optionally masked (for API keys). */
export function InputDialog(props: { theme: Theme; width: number; title: string; label: string; mask?: boolean; initial?: string; onSubmit(value: string): void; onCancel(): void }) {
  const { theme } = props
  const [value, setValue] = useState(props.initial ?? "")
  usePaste((text) => setValue((v) => v + text.replace(/[\r\n]/g, "")))
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) return props.onCancel()
    if (key.return) return props.onSubmit(value.trim())
    if (key.backspace || key.delete) return setValue((v) => [...v].slice(0, -1).join(""))
    if (key.ctrl && input === "u") return setValue("")
    if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return
    const printable = input.replace(/[\u0000-\u001f\u007f]/g, "")
    if (printable) setValue((v) => v + printable)
  })
  const shown = props.mask ? "•".repeat(Math.min([...value].length, props.width - 12)) : value
  return (
    <Frame theme={theme} width={props.width} title={props.title} footer="enter to confirm · esc to cancel">
      <Muted theme={theme}>{props.label}</Muted>
      <Text wrap="truncate-start">
        <Plain theme={theme} bold>{"❯ "}</Plain>
        <Plain theme={theme}>{shown}</Plain>
        <Plain theme={theme} inverse>{" "}</Plain>
      </Text>
    </Frame>
  )
}

/** Scrollable read-only text (help, status). */
export function TextDialog(props: { theme: Theme; width: number; height: number; title: string; markdown: string; onClose(): void }) {
  const [offset, setOffset] = useState(0)
  const lines = useMemo(() => renderMarkdown(props.markdown, props.width - 4), [props.markdown, props.width])
  const rows = Math.max(1, props.height)
  const max = Math.max(0, lines.length - rows)
  useInput((input, key) => {
    if (key.escape || key.return || input === "q" || (key.ctrl && input === "c")) return props.onClose()
    if (key.upArrow || input === "k") setOffset((o) => Math.max(0, o - 1))
    if (key.downArrow || input === "j") setOffset((o) => Math.min(max, o + 1))
    if (key.pageUp) setOffset((o) => Math.max(0, o - rows))
    if (key.pageDown || input === " ") setOffset((o) => Math.min(max, o + rows))
  })
  return (
    <Frame theme={props.theme} width={props.width} title={props.title} footer={max > 0 ? "↑↓ to scroll · esc to close" : "esc to close"}>
      <Lines lines={lines.slice(offset, offset + rows)} theme={props.theme} />
    </Frame>
  )
}

/** The question shown when a tool needs consent. */
export function PermissionDialog(props: { theme: Theme; width: number; request: PendingPermission; queued: number; maxDetailRows?: number; onReply(reply: PermissionReply): void }) {
  const { theme, request } = props
  const [cursor, setCursor] = useState(0)
  const options: { reply: PermissionReply; label: string; key: string }[] = [
    { reply: "once", label: "Allow once", key: "y" },
    { reply: "always", label: "Always allow", key: "a" },
    { reply: "reject", label: "Reject", key: "n" },
  ]
  useInput((input, key) => {
    if (key.leftArrow || key.upArrow) return setCursor((c) => (c + options.length - 1) % options.length)
    if (key.rightArrow || key.downArrow || key.tab) return setCursor((c) => (c + 1) % options.length)
    if (key.return) return props.onReply(options[cursor]!.reply)
    if (key.escape) return props.onReply("reject")
    const hit = options.find((o) => o.key === input.toLowerCase())
    if (hit) props.onReply(hit.reply)
  })

  const meta = request.metadata as Record<string, any>
  const maxDetailRows = props.maxDetailRows ?? 16
  let detail: React.ReactNode = null
  if (maxDetailRows > 0 && typeof meta.diff === "string" && meta.diff.trim() !== "") {
    const rows = meta.diff.split("\n").filter((l: string) => l !== "" && !l.startsWith("---") && !l.startsWith("+++") && !l.startsWith("==="))
    detail = (
      <Box flexDirection="column">
        {rows.slice(0, maxDetailRows).map((row: string, i: number) =>
          row.startsWith("+") ? (
            <Plain key={i} theme={theme} bold wrap="truncate-end">{row.replace(/\t/g, "  ")}</Plain>
          ) : (
            <Text key={i} color={theme.muted} dimColor={!theme.muted} strikethrough={row.startsWith("-")} wrap="truncate-end">{row.replace(/\t/g, "  ")}</Text>
          ),
        )}
        {rows.length > maxDetailRows ? <Muted theme={theme}>{`… ${rows.length - maxDetailRows} more lines`}</Muted> : null}
      </Box>
    )
  } else if (maxDetailRows > 0 && typeof meta.command === "string") {
    detail = (
      <Box flexDirection="column">
        {meta.command.split("\n").slice(0, Math.min(8, maxDetailRows)).map((row: string, i: number) => (
          <Plain key={i} theme={theme} wrap="truncate-end">{(i === 0 ? "$ " : "  ") + row}</Plain>
        ))}
        {meta.description ? <Muted theme={theme}>{String(meta.description)}</Muted> : null}
      </Box>
    )
  } else if (maxDetailRows > 0 && request.patterns.length) {
    detail = <Muted theme={theme} wrap="truncate-middle">{request.patterns.join(", ")}</Muted>
  }

  const always = request.always.join(", ")
  return (
    <Frame theme={theme} width={props.width} title={`Permission required · ${request.permission}`} footer={props.queued > 0 ? `${props.queued} more waiting` : "y / a / n"}>
      <Plain theme={theme} wrap="truncate-end">{request.title.split("\n")[0]}</Plain>
      {detail ? <Box marginTop={1}>{detail}</Box> : null}
      <Box marginTop={1}>
        {options.map((option, i) => (
          <Box key={option.reply} marginRight={2}>
            <Plain theme={theme} inverse={i === cursor} bold={i === cursor}>{` ${option.label} (${option.key}) `}</Plain>
          </Box>
        ))}
      </Box>
      <Muted theme={theme} wrap="truncate-end">{`"Always" covers ${always} for this session`}</Muted>
    </Frame>
  )
}
