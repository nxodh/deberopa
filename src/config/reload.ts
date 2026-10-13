import { resetConfig } from "./config"
import { resetProviders } from "../provider/provider"
import { resetAgents } from "../agent/agent"
import { resetSkills } from "../skill/skill"
import { resetCommands } from "../command/command"
import { shutdownMcp, startMcp } from "../mcp"
import { resetPlugins } from "../plugin"

/** Drop every cache derived from config and reconnect what depends on it. */
export async function reloadProjectState(): Promise<void> {
  resetConfig()
  resetProviders()
  resetAgents()
  resetSkills()
  resetCommands()
  resetPlugins()
  await shutdownMcp()
  void startMcp()
}
