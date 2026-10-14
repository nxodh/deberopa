import { getMessages, listSessions } from "./store"
import { totalTokens } from "./message"

export interface ModelUsage {
  model: string
  messages: number
  input: number
  output: number
  cache: number
  cost: number
}

export interface UsageStats {
  sessions: number
  messages: number
  tokens: number
  cost: number
  models: ModelUsage[]
}

/** Token usage and cost across sessions; shared by `deberopa stats` and the HTTP API. */
export async function usageStats(opts: { all?: boolean; days?: number } = {}): Promise<UsageStats> {
  const cutoff = opts.days ? Date.now() - opts.days * 86_400_000 : 0
  const sessions = (await listSessions({ all: opts.all, includeChildren: true })).filter((s) => s.time.updated >= cutoff)
  const byModel = new Map<string, ModelUsage>()
  let messages = 0
  let cost = 0
  let tokens = 0
  for (const session of sessions) {
    for (const m of await getMessages(session.id)) {
      messages++
      if (m.role !== "assistant" || !m.modelID) continue
      const key = `${m.providerID}/${m.modelID}`
      const row = byModel.get(key) ?? { model: key, messages: 0, input: 0, output: 0, cache: 0, cost: 0 }
      row.messages++
      row.input += m.tokens.input
      row.output += m.tokens.output
      row.cache += m.tokens.cacheRead + m.tokens.cacheWrite
      row.cost += m.cost
      byModel.set(key, row)
      cost += m.cost
      tokens += totalTokens(m.tokens)
    }
  }
  return { sessions: sessions.length, messages, tokens, cost, models: [...byModel.values()].sort((a, b) => b.cost - a.cost) }
}
