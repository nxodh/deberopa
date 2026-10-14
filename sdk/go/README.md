# Go SDK

Go 1.22+, no third-party dependencies. The module is in `sdk/go`; it has not been
published as a separate tagged module. Use a local `replace` pointing at this
directory while developing.

```go
client, err := deberopa.New(deberopa.Options{BaseURL: "http://127.0.0.1:4096"})
if err != nil { panic(err) }
session, err := client.CreateSession(ctx, "Notes")
if err != nil { panic(err) }
reply, err := client.Prompt(ctx, session.ID, deberopa.Prompt{Text: "Explain README.md"})
```

`Request` covers every HTTP API endpoint and returns raw JSON or Markdown.
`Events` consumes SSE with a callback. Cancel its context to stop; use
`PromptAsync` and `ReplyPermission` for permission-driven work. Errors are
`*deberopa.Error` with an HTTP status. Set context deadlines on requests.
Remote servers require HTTPS. Start `deberopa serve` separately.
