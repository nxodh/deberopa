/**
 * Dependency-free HTML to Markdown / plain text. A small tokenizer feeds a tolerant tree
 * builder, and a renderer walks that tree. The output is for LLM context, so it favours
 * readable structure over pixel-faithful layout.
 */

type Token =
  | { kind: "text"; value: string }
  | { kind: "open"; tag: string; attrs: Record<string, string>; selfClosing: boolean }
  | { kind: "close"; tag: string }

interface DomText {
  type: "text"
  value: string
}

interface DomElement {
  type: "element"
  tag: string
  attrs: Record<string, string>
  children: DomNode[]
}

type DomNode = DomText | DomElement

interface RenderOpts {
  md: boolean
  /** Inside a list item, nested lists are packed tightly instead of separated by blank lines. */
  inItem: boolean
}

/** Dropped together with their content. */
const DROP = new Set(["script", "style", "noscript", "iframe", "svg", "head", "template"])
/** Content is raw text, so a "<" inside is not markup. */
const RAW_TEXT = new Set(["script", "style"])
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"])
const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"])
const BLOCK = new Set([
  "address", "article", "aside", "body", "caption", "center", "dd", "details", "dialog", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "header", "hgroup", "html", "main", "nav", "p", "section", "summary",
])
/** Opening one of these closes a still-open <p>, as browsers do. */
const CLOSES_P = new Set([...BLOCK, ...HEADINGS, "blockquote", "hr", "ol", "pre", "table", "ul"])
/** Opening `tag` implicitly closes an open `closes` element, unless a `within` boundary comes first. */
const IMPLIED_CLOSE = new Map<string, { closes: string[]; within: string[] }>([
  ["li", { closes: ["li"], within: ["ul", "ol"] }],
  ["dt", { closes: ["dt", "dd"], within: ["dl"] }],
  ["dd", { closes: ["dt", "dd"], within: ["dl"] }],
  ["tr", { closes: ["tr"], within: ["table", "thead", "tbody", "tfoot"] }],
  ["td", { closes: ["td", "th"], within: ["tr", "table"] }],
  ["th", { closes: ["td", "th"], within: ["tr", "table"] }],
  ["option", { closes: ["option"], within: ["select", "datalist", "optgroup"] }],
])

const NAMED_ENTITIES = new Map<string, string>([
  ["amp", "&"], ["lt", "<"], ["gt", ">"], ["quot", '"'], ["apos", "'"], ["nbsp", " "],
  ["mdash", "—"], ["ndash", "–"], ["hellip", "…"], ["copy", "©"], ["reg", "®"],
  ["trade", "™"], ["laquo", "«"], ["raquo", "»"], ["rsquo", "’"], ["lsquo", "‘"],
  ["ldquo", "“"], ["rdquo", "”"], ["times", "×"], ["middot", "·"], ["bull", "•"],
])

const TAG_NAME = /[a-zA-Z][a-zA-Z0-9:-]*/y
const ATTR_NAME = /[^\s=>/]+/y
const UNQUOTED_VALUE = /[^\s>]*/y

export function htmlToMarkdown(html: string): string {
  return convert(html, true)
}

export function htmlToText(html: string): string {
  return convert(html, false)
}

function convert(html: string, md: boolean): string {
  const tree = buildTree(tokenize(html.replace(/\r\n?/g, "\n")))
  return normalize(renderChildren(tree, { md, inItem: false }))
}

function decodeEntities(s: string): string {
  if (!s.includes("&")) return s
  return s.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X"
      const cp = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10)
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "�"
      return String.fromCodePoint(cp)
    }
    return NAMED_ENTITIES.get(body) ?? whole
  })
}

function skipWhitespace(src: string, from: number): number {
  let k = from
  while (k < src.length && /\s/.test(src.charAt(k))) k++
  return k
}

function parseOpenTag(src: string, start: number): { tag: string; attrs: Record<string, string>; selfClosing: boolean; end: number } | undefined {
  TAG_NAME.lastIndex = start + 1
  const nameMatch = TAG_NAME.exec(src)
  if (!nameMatch) return undefined
  const tag = nameMatch[0].toLowerCase()
  const attrs: Record<string, string> = {}
  let selfClosing = false
  let j = TAG_NAME.lastIndex
  while (j < src.length) {
    const ch = src.charAt(j)
    if (ch === ">") return { tag, attrs, selfClosing, end: j + 1 }
    if (ch === "/") {
      if (src.charAt(j + 1) === ">") selfClosing = true
      j++
      continue
    }
    if (/\s/.test(ch)) {
      j++
      continue
    }
    ATTR_NAME.lastIndex = j
    const attrMatch = ATTR_NAME.exec(src)
    if (!attrMatch) {
      j++
      continue
    }
    const name = attrMatch[0].toLowerCase()
    j = ATTR_NAME.lastIndex
    let k = skipWhitespace(src, j)
    let value = ""
    if (src.charAt(k) === "=") {
      k = skipWhitespace(src, k + 1)
      const quote = src.charAt(k)
      if (quote === '"' || quote === "'") {
        const close = src.indexOf(quote, k + 1)
        const stop = close === -1 ? src.length : close
        value = src.slice(k + 1, stop)
        j = stop + 1
      } else {
        UNQUOTED_VALUE.lastIndex = k
        value = UNQUOTED_VALUE.exec(src)?.[0] ?? ""
        j = UNQUOTED_VALUE.lastIndex
      }
    } else {
      j = k
    }
    if (!Object.hasOwn(attrs, name)) attrs[name] = decodeEntities(value)
  }
  return undefined
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  let text = ""
  let i = 0
  const flush = () => {
    if (text) tokens.push({ kind: "text", value: decodeEntities(text) })
    text = ""
  }
  while (i < src.length) {
    const lt = src.indexOf("<", i)
    if (lt === -1) {
      text += src.slice(i)
      break
    }
    text += src.slice(i, lt)
    i = lt
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4)
      i = end === -1 ? src.length : end + 3
      continue
    }
    const next = src.charAt(i + 1)
    if (next === "!" || next === "?") {
      const end = src.indexOf(">", i)
      i = end === -1 ? src.length : end + 1
      continue
    }
    if (next === "/") {
      TAG_NAME.lastIndex = i + 2
      const nameMatch = TAG_NAME.exec(src)
      if (nameMatch) {
        flush()
        const end = src.indexOf(">", TAG_NAME.lastIndex)
        tokens.push({ kind: "close", tag: nameMatch[0].toLowerCase() })
        i = end === -1 ? src.length : end + 1
        continue
      }
    } else {
      const open = parseOpenTag(src, i)
      if (open) {
        flush()
        tokens.push({ kind: "open", tag: open.tag, attrs: open.attrs, selfClosing: open.selfClosing })
        i = open.end
        if (RAW_TEXT.has(open.tag) && !open.selfClosing) {
          // Skip to the closing tag without parsing what is in between.
          const closeRe = new RegExp(`</${open.tag}[\\s/>]`, "ig")
          closeRe.lastIndex = i
          const m = closeRe.exec(src)
          i = m ? m.index : src.length
        }
        continue
      }
    }
    // A "<" that starts no tag is plain text.
    text += "<"
    i++
  }
  flush()
  return tokens
}

function findClose(tokens: Token[], from: number, tag: string): number {
  let depth = 0
  for (let k = from; k < tokens.length; k++) {
    const tok = tokens[k]
    if (tok?.kind === "open" && tok.tag === tag && !tok.selfClosing) {
      depth++
    } else if (tok?.kind === "close" && tok.tag === tag) {
      if (depth === 0) return k
      depth--
    }
  }
  return -1
}

function closeTag(stack: DomElement[], tag: string) {
  for (let k = stack.length - 1; k >= 1; k--) {
    if (stack[k]?.tag === tag) {
      stack.length = k
      return
    }
  }
}

function closeImplied(stack: DomElement[], tag: string) {
  if (CLOSES_P.has(tag) && stack[stack.length - 1]?.tag === "p") stack.pop()
  const rule = IMPLIED_CLOSE.get(tag)
  if (!rule) return
  for (let k = stack.length - 1; k >= 1; k--) {
    const name = stack[k]?.tag ?? ""
    if (rule.closes.includes(name)) {
      stack.length = k
      return
    }
    if (rule.within.includes(name)) return
  }
}

function buildTree(tokens: Token[]): DomNode[] {
  const root: DomElement = { type: "element", tag: "", attrs: {}, children: [] }
  const stack: DomElement[] = [root]
  const top = () => stack[stack.length - 1] ?? root
  for (let t = 0; t < tokens.length; t++) {
    const tok = tokens[t]
    if (!tok) continue
    if (tok.kind === "text") {
      top().children.push({ type: "text", value: tok.value })
      continue
    }
    if (tok.kind === "close") {
      closeTag(stack, tok.tag)
      continue
    }
    if (DROP.has(tok.tag)) {
      // Skip the whole subtree when its end is found. If it never closes, drop only the tag.
      if (!tok.selfClosing) {
        const end = findClose(tokens, t + 1, tok.tag)
        if (end !== -1) t = end
      }
      continue
    }
    closeImplied(stack, tok.tag)
    const el: DomElement = { type: "element", tag: tok.tag, attrs: tok.attrs, children: [] }
    top().children.push(el)
    if (!VOID.has(tok.tag) && !tok.selfClosing) stack.push(el)
  }
  return root.children
}

function isElement(node: DomNode): node is DomElement {
  return node.type === "element"
}

/** Text content. Raw keeps whitespace as written (for <pre>); otherwise runs collapse to one space. */
function textOf(nodes: DomNode[], raw: boolean): string {
  let out = ""
  for (const node of nodes) {
    if (node.type === "text") out += raw ? node.value : node.value.replace(/\s+/g, " ")
    else if (node.tag === "br") out += "\n"
    else out += textOf(node.children, raw)
  }
  return out
}

function oneLine(s: string): string {
  return s.replace(/\s*\n\s*/g, " ")
}

/** Wrap inline content in markers, keeping its outer whitespace outside them. */
function wrap(inner: string, open: string, close: string): string {
  const flatText = oneLine(inner)
  const core = flatText.trim()
  if (!core) return flatText ? " " : ""
  const lead = /^\s*/.exec(flatText)?.[0] ?? ""
  const trail = /\s*$/.exec(flatText)?.[0] ?? ""
  return `${lead}${open}${core}${close}${trail}`
}

/** A block surrounded by blank lines. Empty content produces nothing. */
function blockOf(inner: string): string {
  const text = inner.trim()
  return text ? `\n\n${text}\n\n` : ""
}

function renderChildren(nodes: DomNode[], o: RenderOpts): string {
  let out = ""
  let afterBreak = false
  for (const node of nodes) {
    if (node.type === "text") {
      // Source indentation after a <br> would otherwise start the new line with a stray space.
      let value = node.value.replace(/\s+/g, " ")
      if (afterBreak) value = value.replace(/^ /, "")
      out += value
      if (value) afterBreak = false
    } else {
      out += renderElement(node, o)
      afterBreak = node.tag === "br"
    }
  }
  return out
}

function renderElement(el: DomElement, o: RenderOpts): string {
  if (HEADINGS.has(el.tag)) return renderHeading(el, o)
  switch (el.tag) {
    case "br":
      return "\n"
    case "hr":
      return o.md ? blockOf("---") : "\n\n"
    case "pre":
      return renderPre(el, o)
    case "ul":
    case "ol":
      return renderList(el, o)
    case "li":
      return blockOf(renderChildren(el.children, o))
    case "blockquote":
      return renderQuote(el, o)
    case "table":
      return renderTable(el, o)
    case "a":
      return renderLink(el, o)
    case "img":
      return renderImage(el, o)
    case "strong":
    case "b":
      return wrap(renderChildren(el.children, o), o.md ? "**" : "", o.md ? "**" : "")
    case "em":
    case "i":
      return wrap(renderChildren(el.children, o), o.md ? "*" : "", o.md ? "*" : "")
    case "code":
    case "kbd":
    case "samp":
    case "tt":
      return codeSpan(el.children, o)
    default:
      return BLOCK.has(el.tag) ? blockOf(renderChildren(el.children, o)) : renderChildren(el.children, o)
  }
}

function renderHeading(el: DomElement, o: RenderOpts): string {
  const text = oneLine(renderChildren(el.children, o)).trim()
  if (!text) return ""
  return blockOf(o.md ? `${"#".repeat(Number(el.tag.slice(1)))} ${text}` : text)
}

function escapeHref(href: string): string {
  return href.replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29")
}

function renderLink(el: DomElement, o: RenderOpts): string {
  const inner = renderChildren(el.children, o)
  const href = (el.attrs["href"] ?? "").trim()
  const usable = href !== "" && !/^javascript:/i.test(href)
  if (!o.md) {
    const label = oneLine(inner).trim()
    if (usable && /^https?:\/\//i.test(href) && label && href !== label) return wrap(inner, "", ` (${href})`)
    return wrap(inner, "", "")
  }
  if (!usable) return wrap(inner, "", "")
  return wrap(inner, "[", `](${escapeHref(href)})`)
}

function renderImage(el: DomElement, o: RenderOpts): string {
  const alt = oneLine(el.attrs["alt"] ?? "").trim()
  if (!alt) return ""
  if (!o.md) return alt
  const src = (el.attrs["src"] ?? "").trim()
  return src ? `![${alt}](${escapeHref(src)})` : alt
}

function codeSpan(nodes: DomNode[], o: RenderOpts): string {
  const text = oneLine(textOf(nodes, false))
  const core = text.trim()
  if (!core) return text ? " " : ""
  if (!o.md) return wrap(text, "", "")
  const longest = Math.max(0, ...(core.match(/`+/g) ?? []).map((run) => run.length))
  const ticks = "`".repeat(longest + 1)
  const pad = core.startsWith("`") || core.endsWith("`") ? " " : ""
  return wrap(text, ticks + pad, pad + ticks)
}

function renderPre(el: DomElement, o: RenderOpts): string {
  const code = el.children.find((child): child is DomElement => isElement(child) && child.tag === "code")
  const lang = /(?:^|\s)(?:language|lang)-([\w+#.-]+)/.exec(code?.attrs["class"] ?? "")?.[1] ?? ""
  // HTML ignores one newline right after <pre> and the one before </pre> is not content.
  const content = textOf(el.children, true).replace(/^\n/, "").replace(/\n$/, "")
  if (!o.md) return `\n\n${content}\n\n`
  const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length))
  const fence = "`".repeat(Math.max(3, longest + 1))
  return `\n\n${fence}${lang}\n${content}\n${fence}\n\n`
}

function renderList(el: DomElement, o: RenderOpts): string {
  const ordered = el.tag === "ol"
  let n = Number.parseInt(el.attrs["start"] ?? "", 10)
  if (!Number.isFinite(n)) n = 1
  const items: DomNode[][] = []
  for (const child of el.children) {
    if (child.type === "text" && !child.value.trim()) continue
    items.push(child.type === "element" && child.tag === "li" ? child.children : [child])
  }
  const lines: string[] = []
  for (const item of items) {
    const marker = ordered ? `${n++}. ` : "- "
    const body = renderChildren(item, { ...o, inItem: true }).trim()
    if (!body) continue
    const pad = " ".repeat(marker.length)
    lines.push(
      body
        .split("\n")
        .map((line, i) => (i === 0 ? marker + line : line ? pad + line : ""))
        .join("\n"),
    )
  }
  if (lines.length === 0) return ""
  const sep = o.inItem ? "\n" : "\n\n"
  return `${sep}${lines.join("\n")}${sep}`
}

function renderQuote(el: DomElement, o: RenderOpts): string {
  const inner = renderChildren(el.children, o).trim()
  if (!inner) return ""
  if (!o.md) return blockOf(inner)
  const lines: string[] = []
  for (const line of inner.split("\n")) {
    if (!line.trim()) {
      // Runs of blank lines become one quoted blank line.
      if (lines[lines.length - 1] !== ">") lines.push(">")
    } else {
      lines.push(`> ${line}`)
    }
  }
  return blockOf(lines.join("\n"))
}

function collectRows(nodes: DomNode[], out: DomElement[]) {
  for (const node of nodes) {
    if (!isElement(node)) continue
    if (node.tag === "tr") out.push(node)
    else if (node.tag === "thead" || node.tag === "tbody" || node.tag === "tfoot") collectRows(node.children, out)
  }
}

function renderTable(el: DomElement, o: RenderOpts): string {
  const rows: DomElement[] = []
  collectRows(el.children, rows)
  const grid = rows
    .map((tr) =>
      tr.children
        .filter((child): child is DomElement => isElement(child) && (child.tag === "td" || child.tag === "th"))
        .map((cell) => {
          const text = oneLine(renderChildren(cell.children, { ...o, inItem: false })).trim()
          return o.md ? text.replace(/\|/g, "\\|") : text
        }),
    )
    .filter((cells) => cells.length > 0)
  const [head, ...rest] = grid
  if (!head) return ""
  const width = Math.max(...grid.map((cells) => cells.length))
  const padRow = (cells: string[]) => [...cells, ...Array<string>(width - cells.length).fill("")]
  if (!o.md) return blockOf(grid.map((cells) => padRow(cells).join("\t")).join("\n"))
  const formatRow = (cells: string[]) => `| ${padRow(cells).join(" | ")} |`
  const separator = `| ${Array<string>(width).fill("---").join(" | ")} |`
  return blockOf([formatRow(head), separator, ...rest.map(formatRow)].join("\n"))
}

/**
 * Tidy the rendered text. Lines inside fenced code are left exactly as written.
 * Elsewhere: trailing spaces go, runs of spaces collapse, and blank lines cap at one.
 */
function normalize(text: string): string {
  const out: string[] = []
  let fence = ""
  for (const line of text.split("\n")) {
    if (fence) {
      out.push(line)
      if (line.replace(/^[\s>]*/, "").trimEnd() === fence) fence = ""
      continue
    }
    const open = /^[\s>]*(`{3,})[^`]*$/.exec(line)
    if (open) {
      fence = open[1] ?? ""
      out.push(line)
      continue
    }
    const clean = line.replace(/[ \t]+$/, "").replace(/(\S) {2,}(?=\S)/g, "$1 ")
    if (clean === "" && out[out.length - 1] === "") continue
    out.push(clean)
  }
  return out.join("\n").trim()
}
