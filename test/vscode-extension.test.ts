import { beforeEach, expect, mock, test } from "bun:test"

// A tiny stand-in for the `vscode` module: enough to drive activate() and watch what it does.
interface FakeTerminal {
  name: string
  exitStatus: undefined | { code: number }
  sent: { text: string; newline: boolean }[]
  shown: number
  sendText(text: string, addNewLine?: boolean): void
  show(): void
}
const commands = new Map<string, (...args: any[]) => any>()
const terminals: FakeTerminal[] = []
const created: any[] = []
const messages: string[] = []
let activeEditor: any
let closeListener: ((t: FakeTerminal) => void) | undefined
let config: Record<string, unknown> = {}

mock.module("vscode", () => ({
  ViewColumn: { Beside: -2 },
  commands: {
    registerCommand: (id: string, fn: (...a: any[]) => any) => {
      commands.set(id, fn)
      return { dispose() {} }
    },
  },
  window: {
    get terminals() {
      return terminals
    },
    get activeTextEditor() {
      return activeEditor
    },
    createTerminal: (options: any) => {
      created.push(options)
      const t: FakeTerminal = {
        name: options.name,
        exitStatus: undefined,
        sent: [],
        shown: 0,
        sendText(text, newline = true) {
          this.sent.push({ text, newline })
        },
        show() {
          this.shown++
        },
      }
      terminals.push(t)
      return t
    },
    onDidCloseTerminal: (fn: (t: FakeTerminal) => void) => {
      closeListener = fn
      return { dispose() {} }
    },
    showInformationMessage: async (m: string) => void messages.push(m),
    showWarningMessage: async (m: string) => void messages.push(m),
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: "/work/app" } }],
    getWorkspaceFolder: () => ({ uri: { fsPath: "/work/app" } }),
    getConfiguration: () => ({ get: (key: string, fallback: unknown) => config[key] ?? fallback }),
  },
}))

// The extension is typechecked in its own project (which has the vscode typings); a non-literal
// specifier keeps this root project from trying to resolve them.
const extensionPath = "../ide/vscode/src/extension"
const ext: { activate(context: unknown): void; deactivate(): void } = await import(extensionPath)

const editor = (file: string, start: [number, number], end: [number, number]) => ({
  document: { uri: { scheme: "file", fsPath: file } },
  selection: { start: { line: start[0], character: start[1] }, end: { line: end[0], character: end[1] }, isEmpty: start[0] === end[0] && start[1] === end[1] },
})

beforeEach(() => {
  commands.clear()
  terminals.length = 0
  created.length = 0
  messages.length = 0
  config = {}
  ext.deactivate()
  ext.activate({ subscriptions: [] } as any)
})

test("registers its three commands", () => {
  expect([...commands.keys()].sort()).toEqual(["vedecaps.addFile", "vedecaps.addSelection", "vedecaps.open"])
})

test("open starts vedecaps in a terminal beside the editor, once", async () => {
  config = { command: "/opt/vedecaps/bin/vedecaps", arguments: ["-m", "anthropic/claude-sonnet-5-5"] }
  await commands.get("vedecaps.open")!()
  await commands.get("vedecaps.open")!()
  expect(created).toHaveLength(1)
  expect(created[0]).toMatchObject({ name: "Vedecaps", cwd: "/work/app", env: { VEDECAPS_CALLER: "vscode" } })
  expect(terminals[0]!.sent).toEqual([{ text: "/opt/vedecaps/bin/vedecaps -m anthropic/claude-sonnet-5-5", newline: true }])
  expect(terminals[0]!.shown).toBe(2)
})

test("the selection is typed into the prompt but not sent", async () => {
  activeEditor = editor("/work/app/src/a.ts", [9, 0], [19, 4])
  await commands.get("vedecaps.addSelection")!()
  const sent = terminals[0]!.sent
  expect(sent[0]).toEqual({ text: "vedecaps", newline: true }) // started first
  expect(sent[1]).toEqual({ text: "@src/a.ts#L10-20 ", newline: false })
  // a second reference reuses the running terminal
  activeEditor = editor("/work/app/src/b.ts", [0, 0], [0, 0])
  await commands.get("vedecaps.addSelection")!()
  expect(terminals).toHaveLength(1)
  expect(terminals[0]!.sent[2]).toEqual({ text: "@src/b.ts ", newline: false })
})

test("a closed terminal is started again; unsupported documents are explained", async () => {
  await commands.get("vedecaps.open")!()
  terminals[0]!.exitStatus = { code: 0 }
  closeListener!(terminals[0]!)
  await commands.get("vedecaps.open")!()
  expect(terminals).toHaveLength(2)

  activeEditor = { document: { uri: { scheme: "untitled", fsPath: "Untitled-1" } }, selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, isEmpty: true } }
  await commands.get("vedecaps.addSelection")!()
  expect(messages.at(-1)).toContain("Open a file")

  activeEditor = editor("/work/app/my docs/a.ts", [0, 0], [0, 0])
  await commands.get("vedecaps.addSelection")!()
  expect(messages.at(-1)).toContain("cannot be written as an @mention")
})

test("add file works from the explorer with an explicit uri", async () => {
  await commands.get("vedecaps.addFile")!({ scheme: "file", fsPath: "/work/app/README.md" })
  expect(terminals[0]!.sent.at(-1)).toEqual({ text: "@README.md ", newline: false })
})
