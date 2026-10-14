import * as vscode from "vscode"
import { formatReference, relativeTo, type Selection } from "./reference"

const TERMINAL_NAME = "Deberopa"
let terminal: vscode.Terminal | undefined

function workspaceRootFor(uri: vscode.Uri | undefined): string | undefined {
  const folder = (uri ? vscode.workspace.getWorkspaceFolder(uri) : undefined) ?? vscode.workspace.workspaceFolders?.[0]
  return folder?.uri.fsPath
}

function ensureTerminal(): { terminal: vscode.Terminal; created: boolean } {
  if (terminal && terminal.exitStatus === undefined) return { terminal, created: false }
  const existing = vscode.window.terminals.find((t) => t.name === TERMINAL_NAME && t.exitStatus === undefined)
  if (existing) {
    terminal = existing
    return { terminal, created: false }
  }
  const config = vscode.workspace.getConfiguration("deberopa")
  const command = config.get<string>("command", "deberopa").trim() || "deberopa"
  const args = config.get<string[]>("arguments", [])
  terminal = vscode.window.createTerminal({
    name: TERMINAL_NAME,
    cwd: workspaceRootFor(vscode.window.activeTextEditor?.document.uri),
    location: { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
    env: { DEBEROPA_CALLER: "vscode" },
  })
  terminal.sendText([command, ...args].join(" "))
  return { terminal, created: true }
}

/** Put text into the prompt without sending it, giving a freshly started TUI a moment to come up. */
async function typeIntoPrompt(text: string) {
  const { terminal: t, created } = ensureTerminal()
  t.show()
  if (created) await new Promise((resolve) => setTimeout(resolve, 1500))
  t.sendText(text, false)
}

function selectionOf(editor: vscode.TextEditor): Selection {
  const s = editor.selection
  return { startLine: s.start.line, endLine: s.end.line, endAtLineStart: s.end.character === 0, isEmpty: s.isEmpty }
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("deberopa.open", () => {
      const { terminal: t } = ensureTerminal()
      t.show()
    }),

    vscode.commands.registerCommand("deberopa.addSelection", async () => {
      const editor = vscode.window.activeTextEditor
      if (!editor || editor.document.uri.scheme !== "file") {
        void vscode.window.showInformationMessage("Open a file in the editor first.")
        return
      }
      const rel = relativeTo(workspaceRootFor(editor.document.uri), editor.document.uri.fsPath)
      const reference = formatReference(rel, selectionOf(editor))
      if (!reference) {
        void vscode.window.showWarningMessage(`"${rel}" has characters that cannot be written as an @mention; mention it by name in the prompt instead.`)
        return
      }
      await typeIntoPrompt(reference)
    }),

    vscode.commands.registerCommand("deberopa.addFile", async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri
      if (!target || target.scheme !== "file") {
        void vscode.window.showInformationMessage("Select a file first.")
        return
      }
      const reference = formatReference(relativeTo(workspaceRootFor(target), target.fsPath))
      if (reference) await typeIntoPrompt(reference)
    }),

    vscode.window.onDidCloseTerminal((closed) => {
      if (closed === terminal) terminal = undefined
    }),
  )
}

export function deactivate() {
  terminal = undefined
}
