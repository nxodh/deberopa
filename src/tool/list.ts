import fs from "node:fs/promises"
import path from "node:path"
import { toPosix } from "../util/fs"
import { walk } from "../util/walk"
import { assertInsideProject, defineTool, resolvePath, ToolInputError } from "./tool"

const MAX_FILES = 100

interface ListArgs {
  path?: string
  ignore?: string[]
}

interface TreeNode {
  dirs: Map<string, TreeNode>
  files: string[]
}

function buildTree(files: string[]): TreeNode {
  const root: TreeNode = { dirs: new Map(), files: [] }
  for (const rel of files) {
    const parts = rel.split("/")
    const name = parts.pop()!
    let node = root
    for (const dir of parts) {
      let next = node.dirs.get(dir)
      if (!next) {
        next = { dirs: new Map(), files: [] }
        node.dirs.set(dir, next)
      }
      node = next
    }
    node.files.push(name)
  }
  return root
}

/** Directories first, then files; each group sorted alphabetically. */
function renderTree(node: TreeNode, depth: number, out: string[]) {
  const indent = "  ".repeat(depth)
  for (const name of [...node.dirs.keys()].sort((a, b) => a.localeCompare(b))) {
    out.push(`${indent}${name}/`)
    renderTree(node.dirs.get(name)!, depth + 1, out)
  }
  for (const name of [...node.files].sort((a, b) => a.localeCompare(b))) out.push(`${indent}${name}`)
}

export const ListTool = defineTool<ListArgs>({
  id: "list",
  description: [
    "Lists the files under a directory as an indented tree, directories first.",
    "Use it to get an overview of a project's layout before reading or searching specific files.",
    "Respects .gitignore and skips node_modules, .git and build output; use ignore to hide more paths.",
    "Shows at most 100 files; point path at a subdirectory to see more of a large tree.",
    "To find files by name pattern use glob, and to search file contents use grep.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Directory to list. Defaults to the session directory.",
      },
      ignore: {
        type: "array",
        items: { type: "string" },
        description: 'Extra gitignore-style patterns to leave out, e.g. ["*.log", "coverage/"].',
      },
    },
  },
  async execute({ path: dirInput, ignore }, ctx) {
    const dir = dirInput ? resolvePath(ctx, dirInput) : ctx.directory
    await assertInsideProject(ctx, dir, "directory")
    const info = await fs.stat(dir).catch(() => undefined)
    if (!info?.isDirectory()) throw new ToolInputError(`Directory not found: ${dir}`)

    // One extra file is walked so truncation can be reported exactly rather than guessed.
    const files: string[] = []
    for await (const file of walk({ cwd: dir, limit: MAX_FILES + 1, extraIgnore: ignore, signal: ctx.abort })) {
      files.push(file.rel)
    }
    ctx.abort.throwIfAborted()

    const truncated = files.length > MAX_FILES
    const shown = files.slice(0, MAX_FILES)
    const lines = [`${toPosix(dir)}/`]
    renderTree(buildTree(shown), 1, lines)
    if (truncated) lines.push(`(Listing truncated at ${MAX_FILES} files.)`)

    return {
      title: toPosix(path.relative(ctx.worktree, dir)) || ".",
      output: lines.join("\n"),
      metadata: { count: shown.length, truncated },
    }
  },
})
