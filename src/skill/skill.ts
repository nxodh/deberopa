import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { loadConfig } from "../config/config"
import { project } from "../project"
import { findUp } from "../util/fs"
import { parseFrontmatter } from "../util/frontmatter"

export interface SkillInfo {
  name: string
  description: string
  /** Directory holding SKILL.md and any files it references. */
  location: string
  content: string
}

let cached: Promise<Record<string, SkillInfo>> | undefined

export function resetSkills() {
  cached = undefined
}

export function listSkills(): Promise<Record<string, SkillInfo>> {
  return (cached ??= load())
}

async function load(): Promise<Record<string, SkillInfo>> {
  const { directories } = await loadConfig()
  const { directory, worktree } = project()
  const roots: string[] = []
  // Skills written for other agents work as they are: the SKILL.md format is shared.
  for (const home of [path.join(os.homedir(), ".claude"), path.join(os.homedir(), ".agents")]) roots.push(path.join(home, "skills"))
  for (const dir of (await findUp([".claude", ".agents"], directory, worktree)).reverse()) roots.push(path.join(dir, "skills"))
  for (const dir of directories) roots.push(path.join(dir, "skill"), path.join(dir, "skills"))

  const skills: Record<string, SkillInfo> = {}
  for (const root of roots) {
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const location = path.join(root, entry.name)
      const text = await fs.readFile(path.join(location, "SKILL.md"), "utf8").catch(() => undefined)
      if (text === undefined) continue
      const { data, content } = parseFrontmatter(text)
      const name = typeof data.name === "string" && data.name.trim() ? data.name.trim() : entry.name
      const description = typeof data.description === "string" ? data.description.trim() : ""
      if (!description) continue
      skills[name] = { name, description, location, content }
    }
  }
  return skills
}
