import { parseBlocks, type Inline } from "./markdown"

function InlineView({ parts }: { parts: Inline[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.t === "code" ? (
          <code key={i}>{p.v}</code>
        ) : p.t === "bold" ? (
          <strong key={i}>{p.v}</strong>
        ) : p.t === "link" ? (
          <a
            key={i}
            href={p.href}
            title={p.href}
            onClick={(e) => {
              e.preventDefault()
              void window.deberopa.openExternal(p.href)
            }}
          >
            {p.v}
          </a>
        ) : (
          <span key={i}>{p.v}</span>
        ),
      )}
    </>
  )
}

/** The agent's answer: a small Markdown subset, always as text nodes (never HTML). */
export function Text({ text }: { text: string }) {
  const blocks = parseBlocks(text)
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.t) {
          case "code":
            return (
              <pre key={i}>
                <code>{b.v}</code>
              </pre>
            )
          case "heading":
            return (
              <p key={i} className={`h h${Math.min(b.level, 3)}`}>
                <InlineView parts={b.inline} />
              </p>
            )
          case "list": {
            const Tag = b.ordered ? "ol" : "ul"
            return (
              <Tag key={i}>
                {b.items.map((item, j) => (
                  <li key={j}>
                    <InlineView parts={item} />
                  </li>
                ))}
              </Tag>
            )
          }
          default:
            return (
              <p key={i}>
                <InlineView parts={b.inline} />
              </p>
            )
        }
      })}
    </>
  )
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
