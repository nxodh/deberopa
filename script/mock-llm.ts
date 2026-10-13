/**
 * A tiny OpenAI-compatible server for manual and scripted UI checks:
 *   bun run script/mock-llm.ts            prints the port, then serves until killed
 * It answers a "read hello.txt" tool call first when asked to "read", otherwise streams text.
 */
const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason: finish }] })
const sse = (events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`)

const server = Bun.serve({
  port: Number(process.env.PORT ?? 0),
  hostname: "127.0.0.1",
  idleTimeout: 60,
  async fetch(req) {
    const body: any = await req.json().catch(() => ({}))
    const messages: any[] = body.messages ?? []
    const system = String(messages[0]?.content ?? "")
    const last = messages[messages.length - 1] ?? {}
    const lastText = typeof last.content === "string" ? last.content : JSON.stringify(last.content ?? "")
    let events: unknown[]
    if (system.startsWith("You generate short titles")) {
      events = [chunk({ content: "Mock session" }), chunk({}, "stop")]
    } else if (last.role === "user" && /\bedit\b/i.test(lastText)) {
      events = [
        chunk({ tool_calls: [{ index: 0, id: "call_w", type: "function", function: { name: "write", arguments: JSON.stringify({ filePath: "notes.txt", content: "line one\nline two\n" }) } }] }),
        chunk({}, "tool_calls"),
      ]
    } else if (last.role === "user" && /\bread\b/i.test(lastText)) {
      events = [
        chunk({ tool_calls: [{ index: 0, id: "call_r", type: "function", function: { name: "read", arguments: JSON.stringify({ filePath: "hello.txt" }) } }] }),
        chunk({}, "tool_calls"),
      ]
    } else {
      const words = "## 결과\n\n요청하신 작업을 **완료**했습니다. `hello.txt` 를 확인했고 다음과 같습니다:\n\n- 첫 번째 항목\n- second item with `code`\n\n```ts\nconst x = 1\n```\n".match(/[\s\S]{1,7}/g)!
      events = [...words.map((w) => chunk({ content: w })), chunk({}, "stop"), { choices: [], usage: { prompt_tokens: 1200, completion_tokens: 80 } }]
    }
    const lines = sse(events)
    const stream = new ReadableStream({
      async start(controller) {
        for (const line of lines) {
          controller.enqueue(new TextEncoder().encode(line))
          await new Promise((r) => setTimeout(r, Number(process.env.DELAY ?? 15)))
        }
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
        controller.close()
      },
    })
    return new Response(stream, { headers: { "content-type": "text/event-stream" } })
  },
})
console.log(server.port)
