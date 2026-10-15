import type { ReactNode } from "react"

/** Text is rendered as text nodes only: model output is never interpreted as HTML. */
export function Text({ text }: { text: string }) {
  const out: ReactNode[] = []
  const re = /```([^\n`]*)\n([\s\S]*?)(```|$)/g
  let last = 0
  let key = 0
  let m: RegExpExecArray | null
  const paragraphs = (chunk: string) => {
    for (const block of chunk.split(/\n{2,}/)) if (block.trim() !== "") out.push(<p key={key++}>{block.trim()}</p>)
  }
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) paragraphs(text.slice(last, m.index))
    out.push(
      <pre key={key++}>
        <code>{m[2]!.replace(/\n$/, "")}</code>
      </pre>,
    )
    last = re.lastIndex
    if (m[3] === "") break
  }
  if (last < text.length) paragraphs(text.slice(last))
  return <>{out}</>
}

export const short = (value: unknown, n = 80) => {
  const s = typeof value === "string" ? value : JSON.stringify(value)
  return s && s.length > n ? s.slice(0, n - 1) + "…" : (s ?? "")
}

export const compactNumber = (n: number) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n))

export function ago(ms: number) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return "now"
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}
