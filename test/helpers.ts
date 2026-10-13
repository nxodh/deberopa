import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { resetConfig } from "../src/config/config"
import { resetProviders } from "../src/provider/provider"
import { resetAgents } from "../src/agent/agent"
import { resetSkills } from "../src/skill/skill"
import { initProject } from "../src/project"
import { resetCommands } from "../src/command/command"
import { resetSnapshot } from "../src/snapshot/snapshot"
import { setCatalog } from "../src/provider/models"

export function tmpDir(prefix = "vdc-") {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
}

export function resetAll() {
  resetConfig()
  resetProviders()
  resetAgents()
  resetSkills()
  resetSnapshot()
  resetCommands()
}

/** Make `dir` the current project and apply a config object on top of the defaults. */
export function useProject(dir: string, config: Record<string, unknown> = {}) {
  initProject(dir)
  setCatalog({})
  process.env.VEDECAPS_CONFIG_CONTENT = JSON.stringify(config)
  resetAll()
}

export type Reply = { chunks?: unknown[]; status?: number; body?: string; delayMs?: number }

/** One chat-completions streaming chunk. */
function chunk(delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) {
  return { id: "mock", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }], ...extra }
}

export const reply = {
  text(text: string, usage = { prompt_tokens: 10, completion_tokens: 5 }): Reply {
    const parts = text.match(/.{1,6}/gs) ?? [text]
    return { chunks: [chunk({ role: "assistant" }), ...parts.map((p) => chunk({ content: p })), chunk({}, "stop"), { choices: [], usage }] }
  },
  tools(calls: { name: string; args: unknown; id?: string }[], text = ""): Reply {
    const out: unknown[] = [chunk({ role: "assistant" })]
    if (text) out.push(chunk({ content: text }))
    calls.forEach((c, i) => {
      const id = c.id ?? `call_${i}`
      const json = JSON.stringify(c.args)
      out.push(chunk({ tool_calls: [{ index: i, id, type: "function", function: { name: c.name, arguments: "" } }] }))
      const mid = Math.floor(json.length / 2)
      out.push(chunk({ tool_calls: [{ index: i, function: { arguments: json.slice(0, mid) } }] }))
      out.push(chunk({ tool_calls: [{ index: i, function: { arguments: json.slice(mid) } }] }))
    })
    out.push(chunk({}, "tool_calls"), { choices: [], usage: { prompt_tokens: 20, completion_tokens: 8 } })
    return { chunks: out }
  },
  error(status: number, message: string): Reply {
    return { status, body: JSON.stringify({ error: { message } }) }
  },
}

export interface MockLLM {
  url: string
  requests: any[]
  /** Queue replies in order; when empty the server answers "ok". */
  queue(...replies: (Reply | ((body: any) => Reply))[]): void
  reset(): void
  stop(): void
}

export function startMockLLM(): MockLLM {
  const queue: (Reply | ((body: any) => Reply))[] = []
  const requests: any[] = []
  const titles: any[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
      const body = await req.json()
      // Title generation runs concurrently with the real turn; keep it out of the scripted queue.
      if (String(body.messages?.[0]?.content ?? "").startsWith("You generate short titles")) {
        titles.push(body)
        return new Response(reply.text("Mock title").chunks!.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
      }
      requests.push(body)
      const next = queue.shift()
      const r = typeof next === "function" ? next(body) : (next ?? reply.text("ok"))
      if (r.delayMs) await new Promise((res) => setTimeout(res, r.delayMs))
      if (r.status) return new Response(r.body ?? "", { status: r.status, headers: { "content-type": "application/json" } })
      const payload = (r.chunks ?? []).map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n"
      return new Response(payload, { headers: { "content-type": "text/event-stream" } })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    requests,
    queue: (...r) => void queue.push(...r),
    reset: () => {
      queue.length = 0
      requests.length = 0
    },
    stop: () => void server.stop(true),
  }
}

export function mockConfig(mock: MockLLM, extra: Record<string, unknown> = {}) {
  return {
    model: "mock/mock-1",
    snapshot: false,
    provider: {
      mock: {
        name: "Mock",
        api: mock.url,
        models: { "mock-1": { name: "Mock 1", tool_call: true, limit: { context: 100000, output: 4000 } } },
      },
    },
    ...extra,
  }
}
