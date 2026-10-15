import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import { css } from "@codemirror/lang-css"
import { html } from "@codemirror/lang-html"
import { javascript } from "@codemirror/lang-javascript"
import { json } from "@codemirror/lang-json"
import { markdown } from "@codemirror/lang-markdown"
import { python } from "@codemirror/lang-python"
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting, type LanguageSupport } from "@codemirror/language"
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search"
import { EditorState } from "@codemirror/state"
import { drawSelection, EditorView, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view"
import { tags } from "@lezer/highlight"
import { useEffect, useRef, useState } from "react"
import { markDirty, type Tab } from "./store"

// The interface is monochrome: syntax is told apart by weight, slant and dimness, not by hue.
const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.definitionKeyword, tags.modifier], fontWeight: "700" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], fontStyle: "italic", opacity: "0.65" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], textDecoration: "underline dotted", textUnderlineOffset: "3px" },
  { tag: [tags.number, tags.bool, tags.null], fontWeight: "600" },
  { tag: [tags.definition(tags.variableName), tags.function(tags.variableName), tags.className, tags.typeName], fontWeight: "600" },
  { tag: [tags.heading], fontWeight: "700" },
  { tag: [tags.emphasis], fontStyle: "italic" },
  { tag: [tags.strong], fontWeight: "700" },
  { tag: [tags.link, tags.url], textDecoration: "underline" },
])

const theme = EditorView.theme({
  "&": { height: "100%", background: "var(--bg)", color: "var(--text)", fontSize: "13px" },
  ".cm-scroller": { fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace', lineHeight: "1.55" },
  ".cm-content": { caretColor: "var(--text)" },
  ".cm-gutters": { background: "var(--panel)", color: "var(--dim)", border: "0", borderRight: "1px solid var(--line)" },
  ".cm-activeLine": { background: "var(--hover)" },
  ".cm-activeLineGutter": { background: "var(--hover)", color: "var(--text)" },
  "&.cm-focused .cm-cursor": { borderLeftColor: "var(--text)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { background: "var(--active)" },
  ".cm-searchMatch": { outline: "1px solid var(--text)", background: "transparent" },
  ".cm-searchMatch.cm-searchMatch-selected": { background: "var(--active)" },
  ".cm-panels": { background: "var(--panel)", color: "var(--text)", borderColor: "var(--line)" },
  ".cm-panel input, .cm-panel button": { font: "inherit" },
})

function languageFor(name: string): LanguageSupport | undefined {
  const ext = name.toLowerCase().split(".").pop() ?? ""
  switch (ext) {
    case "ts":
    case "tsx":
      return javascript({ typescript: true, jsx: ext === "tsx" })
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return javascript({ jsx: true })
    case "json":
    case "jsonc":
      return json()
    case "md":
    case "markdown":
      return markdown()
    case "py":
      return python()
    case "html":
    case "htm":
      return html()
    case "css":
      return css()
  }
  return undefined
}

export function Editor({ tab }: { tab: Extract<Tab, { kind: "file" }> }) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const loaded = useRef<{ mtimeMs: number; size: number; saved: string }>({ mtimeMs: 0, size: 0, saved: "" })
  const dirty = useRef(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState<"" | "changed" | "saved">("")
  const [ready, setReady] = useState(false)
  const name = tab.path.split("/").pop() ?? tab.path

  const setDirty = (value: boolean) => {
    if (dirty.current === value) return
    dirty.current = value
    markDirty(tab.id, value)
  }

  const save = async (force = false) => {
    const v = view.current
    if (!v) return
    const text = v.state.doc.toString()
    const res = await window.deberopa.writeFile(tab.dir, tab.path, text, { mtimeMs: loaded.current.mtimeMs, size: loaded.current.size }, force)
    if (res.ok) {
      loaded.current = { mtimeMs: res.mtimeMs ?? loaded.current.mtimeMs, size: res.size ?? loaded.current.size, saved: text }
      setDirty(false)
      setNotice("saved")
      setError("")
    } else if (res.conflict) setNotice("changed")
    else setError(res.error ?? "Could not save.")
  }
  const saveRef = useRef(save)
  saveRef.current = save

  const replaceText = (text: string) => {
    const v = view.current
    if (!v) return
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } })
  }

  const reload = async () => {
    const res = await window.deberopa.readFile(tab.dir, tab.path)
    if (!res.ok) return setError(res.error ?? "Could not read the file.")
    loaded.current = { mtimeMs: res.mtimeMs ?? 0, size: res.size ?? 0, saved: res.text ?? "" }
    replaceText(res.text ?? "")
    setDirty(false)
    setNotice("")
  }

  // open the file
  useEffect(() => {
    let cancelled = false
    void window.deberopa.readFile(tab.dir, tab.path).then((res) => {
      if (cancelled) return
      if (!res.ok) return setError(res.error ?? "Could not read the file.")
      loaded.current = { mtimeMs: res.mtimeMs ?? 0, size: res.size ?? 0, saved: res.text ?? "" }
      const language = languageFor(name)
      const state = EditorState.create({
        doc: res.text ?? "",
        extensions: [
          lineNumbers(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          syntaxHighlighting(highlight),
          theme,
          ...(language ? [language] : []),
          keymap.of([{ key: "Mod-s", preventDefault: true, run: () => (void saveRef.current(), true) }, indentWithTab, ...searchKeymap, ...historyKeymap, ...defaultKeymap]),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return
            const text = u.state.doc.toString()
            // not inside CodeMirror's own update: the store change re-renders React synchronously
            queueMicrotask(() => {
              setDirty(text !== loaded.current.saved)
              setNotice((n) => (n === "saved" ? "" : n))
            })
          }),
        ],
      })
      view.current = new EditorView({ state, parent: host.current! })
      setReady(true)
    })
    return () => {
      cancelled = true
      view.current?.destroy()
      view.current = null
      markDirty(tab.id, false)
    }
  }, [tab.dir, tab.path])

  // the agent (or another program) may change the file while it is open
  useEffect(() => {
    if (!ready) return
    const timer = setInterval(async () => {
      const stat = await window.deberopa.statFile(tab.dir, tab.path)
      if (!stat.ok || stat.mtimeMs === undefined) return
      // a coarse clock can give two writes the same time: the size is compared as well
      if (Math.abs(stat.mtimeMs - loaded.current.mtimeMs) <= 1 && stat.size === loaded.current.size) return
      if (!dirty.current) await reload()
      else setNotice("changed")
    }, 1200)
    return () => clearInterval(timer)
  }, [ready, tab.dir, tab.path])

  return (
    <div className="editor" data-testid="editor">
      <div className="editor-bar">
        <span className="name">{tab.path}</span>
        <span className="spacer" />
        {notice === "saved" ? <span className="sub">Saved</span> : null}
        <button className="primary" data-testid="save" onClick={() => void save()} disabled={!ready}>
          Save
        </button>
      </div>
      {notice === "changed" ? (
        <div className="banner" role="alert">
          <span>This file changed on disk (the agent or another program edited it).</span>
          <button onClick={() => void reload()}>Load the new version</button>
          <button onClick={() => void save(true)}>Keep mine and overwrite</button>
        </div>
      ) : null}
      {error ? <div className="error">{error}</div> : null}
      <div className="editor-host" ref={host} />
    </div>
  )
}
