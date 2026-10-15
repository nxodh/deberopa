// A small, safe subset of Markdown for the agent's answers: fenced code, headings, lists, bold,
// inline code and http(s) links. Everything becomes text nodes; nothing is ever interpreted as HTML.
export type Inline = { t: "text"; v: string } | { t: "code"; v: string } | { t: "bold"; v: string } | { t: "link"; v: string; href: string }
export type Block =
  | { t: "code"; lang: string; v: string }
  | { t: "heading"; level: number; inline: Inline[] }
  | { t: "list"; ordered: boolean; items: Inline[][] }
  | { t: "p"; inline: Inline[] }

export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  const re = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ t: "text", v: text.slice(last, m.index) })
    if (m[1] !== undefined) out.push({ t: "code", v: m[1] })
    else if (m[2] !== undefined) out.push({ t: "bold", v: m[2] })
    else out.push({ t: "link", v: m[3]!, href: m[4]! })
    last = re.lastIndex
  }
  if (last < text.length) out.push({ t: "text", v: text.slice(last) })
  return out
}

export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = []
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  let i = 0
  let para: string[] = []
  const flush = () => {
    if (para.length) blocks.push({ t: "p", inline: parseInline(para.join("\n")) })
    para = []
  }
  while (i < lines.length) {
    const line = lines[i]!
    const fence = /^\s*```([^\n`]*)$/.exec(line)
    if (fence) {
      flush()
      const body: string[] = []
      i++
      // an unterminated fence (a reply still streaming) runs to the end
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) body.push(lines[i++]!)
      i++
      blocks.push({ t: "code", lang: fence[1]!.trim(), v: body.join("\n") })
      continue
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading) {
      flush()
      blocks.push({ t: "heading", level: heading[1]!.length, inline: parseInline(heading[2]!) })
      i++
      continue
    }
    const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line)
    if (item) {
      flush()
      const ordered = item[2] !== undefined
      const items: Inline[][] = []
      while (i < lines.length) {
        const m = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(lines[i]!)
        if (!m || (m[2] !== undefined) !== ordered) break
        items.push(parseInline(m[3]!))
        i++
      }
      blocks.push({ t: "list", ordered, items })
      continue
    }
    if (line.trim() === "") {
      flush()
      i++
      continue
    }
    para.push(line)
    i++
  }
  flush()
  return blocks
}
