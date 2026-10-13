import { defineTool, ToolInputError, type ToolDefinition } from "./tool"
import { listSkills } from "../skill/skill"

/** Built per request so the description always lists the skills that exist right now. */
export async function createSkillTool(): Promise<ToolDefinition | undefined> {
  const skills = Object.values(await listSkills())
  if (skills.length === 0) return undefined
  return defineTool<{ name: string }>({
    id: "skill",
    description: `Load a skill: a set of specialised instructions (and sometimes scripts or reference files) for a particular kind of task.

When a task matches one of the skills below, load it BEFORE starting the work and follow its instructions. Only names from this list are valid.

<available_skills>
${skills.map((s) => `  <skill>\n    <name>${s.name}</name>\n    <description>${s.description}</description>\n  </skill>`).join("\n")}
</available_skills>`,
    parameters: {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string", description: "Name of the skill to load, exactly as listed" } },
    },
    async execute(args, ctx) {
      const all = await listSkills()
      const skill = all[args.name]
      if (!skill) throw new ToolInputError(`Skill "${args.name}" not found. Available skills: ${Object.keys(all).join(", ") || "none"}`)
      await ctx.ask({ permission: "skill", patterns: [skill.name], always: [skill.name], title: `Load skill ${skill.name}`, metadata: { name: skill.name } })
      return {
        title: `Loaded skill: ${skill.name}`,
        output: `## Skill: ${skill.name}\n\n**Base directory**: ${skill.location}\n\nFiles referenced by the skill are relative to the base directory.\n\n${skill.content}`,
        metadata: { name: skill.name, location: skill.location },
      }
    },
  })
}
