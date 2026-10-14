# @deberopa/sdk

A small, dependency-free client for the [Deberopa](https://github.com/nxodh/deberopa) HTTP API.

```ts
import { startServer, messageText } from "@deberopa/sdk"

const { client, close } = await startServer({ cwd: "/path/to/project" }) // spawns `deberopa serve`
const session = await client.session.create({ title: "docs" })

// follow progress while the agent works
const controller = new AbortController()
void (async () => {
  for await (const event of client.event.subscribe(controller.signal)) {
    if (event.type === "permission.asked") await client.permission.reply(event.properties.id, "once")
  }
})()

const reply = await client.session.prompt(session.id, { text: "summarise README.md", model: "anthropic/claude-sonnet-5-5" })
console.log(messageText(reply))

controller.abort()
await close()
```

To use a server that is already running, `createClient({ baseUrl: "http://127.0.0.1:4096", password })`.

Not yet published to npm: use it from a checkout (`sdk/js/src/index.ts`) or build it with `npm run build`.
