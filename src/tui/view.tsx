import React from "react"
import path from "node:path"
import { Box, Text } from "ink"
import stringWidth from "string-width"
import { VERSION } from "../global"
import { renderMarkdown, type Line } from "./markdown"
import { MARK, WORDMARK } from "./logo"
import type { Theme } from "./theme"
import type { AssistantMessage, Message, ToolPart, UserMessage } from "../session/message"

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

export function Muted(props: { theme: Theme; children: React.ReactNode; bold?: boolean; italic?: boolean; wrap?: "wrap" | "truncate-end" | "truncate-middle" }) {
  return (
    <Text color={props.theme.muted} dimColor={!props.theme.muted} bold={props.bold} italic={props.italic} wrap={props.wrap}>
      {props.children}
    </Text>
  )
}

export function Plain(props: { theme: Theme; children: React.ReactNode; bold?: boolean; inverse?: boolean; wrap?: "wrap" | "truncate-end" | "truncate-middle" }) {
  return (
    <Text color={props.theme.text} bold={props.bold} inverse={props.inverse} wrap={props.wrap}>
      {props.children}
    </Text>
  )
}

/** Pre-wrapped styled lines (from the markdown renderer) drawn one row each. */
export function Lines(props: { lines: Line[]; theme: Theme; muted?: boolean }) {
  const { theme } = props
  return (
    <Box flexDirection="column">
      {props.lines.map((line, i) => (
        <Text key={i} wrap="truncate-end">
          {line.length === 0
            ? " "
            : line.map((span, j) => {
                const dim = span.dim || props.muted
                return (
                  <Text
                    key={j}
                    color={dim ? theme.muted : theme.text}
                    dimColor={dim && !theme.muted}
                    bold={span.bold}
                    italic={span.italic}
                    underline={span.underline}
                    inverse={span.inverse}
                    strikethrough={span.strikethrough}
                  >
                    {span.text}
                  </Text>
                )
              })}
        </Text>
      ))}
    </Box>
  )
}

export function Header(props: { theme: Theme; directory: string; width: number }) {
  const { theme } = props
  const home = process.env.HOME || process.env.USERPROFILE || ""
  const cwd = home && props.directory.startsWith(home) ? "~" + props.directory.slice(home.length) : props.directory
  const side = [
    "",
    WORDMARK,
    `v${VERSION}`,
    "",
    cwd,
    "/help for commands · @ to attach files · ! to run a shell command",
  ]
  const narrow = props.width < 64
  return (
    <Box marginTop={1} marginLeft={1} flexDirection={narrow ? "column" : "row"}>
      <Box flexDirection="column" marginRight={3}>
        {MARK.map((row, i) => (
          <Plain key={i} theme={theme} bold>
            {row}
          </Plain>
        ))}
      </Box>
      <Box flexDirection="column">
        {side.map((row, i) =>
          i === 1 ? (
            <Plain key={i} theme={theme} bold>
              {row}
            </Plain>
          ) : (
            <Muted key={i} theme={theme} wrap="truncate-middle">
              {row || " "}
            </Muted>
          ),
        )}
      </Box>
    </Box>
  )
}

function clip(text: string, width: number): string {
  if (stringWidth(text) <= width) return text
  let out = ""
  let w = 0
  for (const ch of text) {
    const cw = stringWidth(ch)
    if (w + cw > width - 1) break
    out += ch
    w += cw
  }
  return out + "…"
}

function relative(file: unknown): string {
  if (typeof file !== "string" || file === "") return ""
  const rel = path.relative(process.cwd(), file)
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : file
}

/** One-line description of what a tool call is doing. */
export function toolSummary(part: ToolPart): { name: string; detail: string } {
  const input = (part.state.input ?? {}) as Record<string, any>
  const state = part.state
  const meta = (state.status === "completed" || state.status === "running" ? state.metadata : undefined) ?? {}
  switch (part.tool) {
    case "bash":
      return { name: "Bash", detail: String(input.command ?? "").split("\n")[0] ?? "" }
    case "read":
      return { name: "Read", detail: relative(input.filePath) + (input.offset ? `:${input.offset}` : "") }
    case "edit":
    case "multiedit":
      return { name: "Edit", detail: relative(input.filePath) + counts(meta) }
    case "write":
      return { name: meta.created === false ? "Overwrite" : "Write", detail: relative(input.filePath) + counts(meta) }
    case "patch":
      return { name: "Patch", detail: (state.status === "completed" ? state.title : "") + counts(meta) }
    case "glob":
      return { name: "Glob", detail: `${input.pattern ?? ""}${typeof meta.count === "number" ? `  (${meta.count} files)` : ""}` }
    case "grep":
      return { name: "Grep", detail: `${input.pattern ?? ""}${input.include ? ` in ${input.include}` : ""}${typeof meta.matches === "number" ? `  (${meta.matches} matches)` : ""}` }
    case "list":
      return { name: "List", detail: relative(input.path) || "." }
    case "webfetch":
      return { name: "Fetch", detail: String(input.url ?? "") }
    case "todowrite":
      return { name: "Plan", detail: state.status === "completed" ? state.title : "" }
    case "todoread":
      return { name: "Plan", detail: "read" }
    case "task":
      return { name: "Task", detail: `${input.description ?? ""}${input.subagent_type ? `  (@${input.subagent_type})` : ""}` }
    case "skill":
      return { name: "Skill", detail: String(input.name ?? "") }
    default:
      return { name: part.tool, detail: state.status === "completed" ? state.title : compactJSON(input) }
  }
}

function counts(meta: Record<string, unknown>): string {
  if (typeof meta.additions !== "number" || typeof meta.deletions !== "number") return ""
  return `  (+${meta.additions} −${meta.deletions})`
}

function compactJSON(value: unknown): string {
  try {
    const text = JSON.stringify(value)
    return text === "{}" ? "" : text
  } catch {
    return ""
  }
}

function tail(text: string, lines: number): { rows: string[]; hidden: number } {
  const all = text.replace(/\s+$/, "").split("\n")
  if (all.length <= lines) return { rows: all, hidden: 0 }
  return { rows: all.slice(-lines), hidden: all.length - lines }
}

function DiffView(props: { diff: string; theme: Theme; width: number; limit: number }) {
  const rows = props.diff.split("\n").filter((l) => !l.startsWith("---") && !l.startsWith("+++") && !l.startsWith("\\") && !l.startsWith("===") && l !== "")
  const shown = rows.slice(0, props.limit)
  return (
    <Box flexDirection="column" marginLeft={2}>
      {shown.map((row, i) => {
        const text = clip(row.replace(/\t/g, "  "), props.width - 4)
        if (row.startsWith("@@")) return <Muted key={i} theme={props.theme}>{text}</Muted>
        if (row.startsWith("+")) return <Plain key={i} theme={props.theme} bold>{text}</Plain>
        if (row.startsWith("-")) return <Text key={i} color={props.theme.muted} dimColor={!props.theme.muted} strikethrough>{text}</Text>
        return <Muted key={i} theme={props.theme}>{text}</Muted>
      })}
      {rows.length > shown.length ? <Muted theme={props.theme}>{`… ${rows.length - shown.length} more lines (/details to expand)`}</Muted> : null}
    </Box>
  )
}

export function ToolView(props: { part: ToolPart; theme: Theme; width: number; details: boolean; frame?: number }) {
  const { part, theme, width, details } = props
  const state = part.state
  const { name, detail } = toolSummary(part)
  const active = state.status === "pending" || state.status === "running"
  const glyph = state.status === "error" ? "✗" : active ? SPINNER[(props.frame ?? 0) % SPINNER.length]! : "◆"
  const meta = ((state.status === "completed" || state.status === "running" ? state.metadata : undefined) ?? {}) as Record<string, any>
  const input = (state.input ?? {}) as Record<string, any>

  let body: React.ReactNode = null
  if (state.status === "error") {
    body = (
      <Box marginLeft={2}>
        <Muted theme={theme}>{clip(state.error.split("\n").slice(0, details ? 12 : 3).join(" ⏎ "), (width - 4) * (details ? 4 : 2))}</Muted>
      </Box>
    )
  } else if (part.tool === "bash") {
    const output = String(meta.output ?? (state.status === "completed" ? state.output : "") ?? "")
    if (output.trim() !== "") {
      const t = tail(output, details ? 40 : active ? 6 : 4)
      body = (
        <Box flexDirection="column" marginLeft={2}>
          {t.hidden > 0 ? <Muted theme={theme}>{`│ … ${t.hidden} earlier lines`}</Muted> : null}
          {t.rows.map((row, i) => (
            <Muted key={i} theme={theme}>{"│ " + clip(row.replace(/\t/g, "  "), width - 6)}</Muted>
          ))}
        </Box>
      )
    }
  } else if ((part.tool === "edit" || part.tool === "multiedit" || part.tool === "write" || part.tool === "patch") && typeof meta.diff === "string") {
    body = <DiffView diff={meta.diff} theme={theme} width={width} limit={details ? 200 : 14} />
  } else if (part.tool === "todowrite" && Array.isArray(input.todos)) {
    body = (
      <Box flexDirection="column" marginLeft={2}>
        {input.todos.map((todo: any, i: number) => {
          const text = clip(String(todo.content ?? ""), width - 6)
          if (todo.status === "completed") return <Text key={i} color={theme.muted} dimColor={!theme.muted} strikethrough>{"☑ " + text}</Text>
          if (todo.status === "cancelled") return <Text key={i} color={theme.muted} dimColor={!theme.muted} strikethrough>{"☒ " + text}</Text>
          if (todo.status === "in_progress") return <Plain key={i} theme={theme} bold>{"▣ " + text}</Plain>
          return <Plain key={i} theme={theme}>{"☐ " + text}</Plain>
        })}
      </Box>
    )
  } else if (part.tool === "task" && Array.isArray(meta.summary) && meta.summary.length) {
    const items = (meta.summary as { tool: string; title: string; status: string }[]).slice(details ? -30 : -4)
    body = (
      <Box flexDirection="column" marginLeft={2}>
        {meta.summary.length > items.length ? <Muted theme={theme}>{`└ … ${meta.summary.length - items.length} earlier steps`}</Muted> : null}
        {items.map((item, i) => (
          <Muted key={i} theme={theme}>{clip(`└ ${item.status === "error" ? "✗ " : ""}${item.tool}  ${item.title ?? ""}`, width - 4)}</Muted>
        ))}
      </Box>
    )
  } else if (details && state.status === "completed" && state.output.trim() !== "" && part.tool !== "todoread") {
    const t = tail(state.output, 12)
    body = (
      <Box flexDirection="column" marginLeft={2}>
        {t.rows.map((row, i) => (
          <Muted key={i} theme={theme}>{"│ " + clip(row.replace(/\t/g, "  "), width - 6)}</Muted>
        ))}
        {t.hidden > 0 ? <Muted theme={theme}>{`│ … ${t.hidden} more lines`}</Muted> : null}
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Plain theme={theme} bold={state.status === "error"}>{glyph + " "}</Plain>
        <Plain theme={theme} bold>{name}</Plain>
        <Muted theme={theme}>{detail ? "  " + detail.replace(/\s+/g, " ") : ""}</Muted>
      </Text>
      {body}
    </Box>
  )
}

function UserView(props: { message: UserMessage; theme: Theme; width: number }) {
  const { message, theme } = props
  if (message.compaction) {
    return (
      <Box marginTop={1} marginLeft={1}>
        <Muted theme={theme}>{"─── context compacted " + "─".repeat(Math.max(0, Math.min(40, props.width - 26)))}</Muted>
      </Box>
    )
  }
  const text = message.parts.filter((p) => p.type === "text" && !p.synthetic).map((p) => (p.type === "text" ? p.text : "")).join("\n")
  const files = message.parts.filter((p) => p.type === "file")
  const attached = message.parts.filter((p) => p.type === "text" && p.synthetic && /^Called the (read|list) tool/.test(p.text)).length
  if (text.trim() === "" && files.length === 0) {
    // purely synthetic messages (shell runs, auto-continue) need no bubble
    const synthetic = message.parts.find((p) => p.type === "text" && p.synthetic)
    if (!synthetic || synthetic.type !== "text" || !/compacted/.test(synthetic.text)) return null
    return (
      <Box marginTop={1} marginLeft={1}>
        <Muted theme={theme}>↻ continuing after compaction</Muted>
      </Box>
    )
  }
  return (
    <Box
      marginTop={1}
      borderStyle="bold"
      borderColor={theme.text}
      borderTop={false}
      borderBottom={false}
      borderRight={false}
      paddingLeft={1}
      flexDirection="column"
      width={props.width}
    >
      <Plain theme={theme} bold>{text.replace(/\t/g, "  ")}</Plain>
      {files.length + attached > 0 ? (
        <Muted theme={theme}>
          {[...files.map((f) => (f.type === "file" ? `[${f.filename ?? f.mime}]` : "")), attached ? `[${attached} file${attached === 1 ? "" : "s"} attached]` : ""].filter(Boolean).join(" ")}
        </Muted>
      ) : null}
    </Box>
  )
}

function AssistantView(props: { message: AssistantMessage; theme: Theme; width: number; details: boolean; frame?: number; live?: boolean }) {
  const { message, theme, width, details } = props
  const inner = Math.max(20, width - 2)
  const blocks: React.ReactNode[] = []
  for (const part of message.parts) {
    if (part.type === "text") {
      if (part.text.trim() === "") continue
      blocks.push(
        <Box key={part.id} marginTop={1} marginLeft={1}>
          <Lines lines={renderMarkdown(part.text, inner)} theme={theme} />
        </Box>,
      )
    } else if (part.type === "reasoning") {
      if (part.text.trim() === "") continue
      const all = renderMarkdown(part.text, inner - 2)
      const lines = details ? all : all.slice(-3)
      const seconds = part.time.end ? Math.max(1, Math.round((part.time.end - part.time.start) / 1000)) : undefined
      blocks.push(
        <Box key={part.id} marginTop={1} marginLeft={1} flexDirection="column">
          <Muted theme={theme} italic>
            {seconds ? `∴ Thought for ${seconds}s` : "∴ Thinking…"}
            {!details && all.length > lines.length ? "  (/details to expand)" : ""}
          </Muted>
          {details || props.live ? (
            <Box marginLeft={2}>
              <Lines lines={lines} theme={theme} muted />
            </Box>
          ) : null}
        </Box>,
      )
    } else if (part.type === "tool") {
      blocks.push(
        <Box key={part.id} marginTop={1} marginLeft={1}>
          <ToolView part={part} theme={theme} width={inner} details={details} frame={props.frame} />
        </Box>,
      )
    }
  }
  if (message.error && message.error.name !== "Aborted") {
    blocks.push(
      <Box key="error" marginTop={1} marginLeft={1}>
        <Text>
          <Plain theme={theme} inverse bold>{" ERROR "}</Plain>
          <Plain theme={theme}>{" " + message.error.message}</Plain>
        </Text>
      </Box>,
    )
  } else if (message.error) {
    blocks.push(
      <Box key="aborted" marginTop={1} marginLeft={1}>
        <Muted theme={theme}>■ interrupted</Muted>
      </Box>,
    )
  }
  const final = !!message.time.completed && !message.error && !message.parts.some((p) => p.type === "tool")
  if (final && !message.summary) {
    const seconds = ((message.time.completed! - message.time.created) / 1000).toFixed(1)
    blocks.push(
      <Box key="footer" marginTop={1} marginLeft={1}>
        <Muted theme={theme}>{`▪ ${message.agent} · ${message.modelID} · ${seconds}s`}</Muted>
      </Box>,
    )
  }
  if (message.summary && message.time.completed) {
    blocks.unshift(
      <Box key="summary" marginTop={1} marginLeft={1}>
        <Muted theme={theme} bold>Summary of the conversation so far</Muted>
      </Box>,
    )
  }
  if (blocks.length === 0) return null
  return <Box flexDirection="column">{blocks}</Box>
}

export function MessageView(props: { message: Message; theme: Theme; width: number; details: boolean; frame?: number; live?: boolean }) {
  if (props.message.role === "user") return <UserView message={props.message} theme={props.theme} width={props.width} />
  return <AssistantView {...props} message={props.message} />
}
