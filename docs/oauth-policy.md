# OAuth scope review

Reviewed against official documentation on 2026-10-14. The current development
request requires a conservative decision: do not implement an OAuth integration
if permission or safe operation is uncertain. No subscription or MCP OAuth code
was added in this change. Existing API-key and explicit MCP-header authentication
remain available. Bedrock, Vertex and Azure were explicitly excluded.

## Anthropic subscription accounts

[Anthropic's credential-use rules](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)
restrict offering Claude.ai login inside a third-party app and collecting or
intermediating subscription/session credentials. Vedecaps must not extract tokens
from Claude Code, Keychain or another application, impersonate that client, or
route subscription credentials to its own model adapter. API keys remain the
supported integration here. Operating the unmodified official CLI is a separate
product path and is not implemented as a workaround.

## ChatGPT subscription accounts

OpenAI documents an official open-source registration route; it must not be
described as universally prohibited or necessarily requiring a partner secret.
[Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
describes per-account dynamic registration, user consent, PKCE, state, nonce and
identity/permission validation.
[Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
requires authorized Responses API usage and explicitly excludes private
backend-api endpoints. Vedecaps currently uses Chat Completions and has no
validated account/workspace-bound OAuth or Responses implementation. Under the
requested conservative standard, this integration is deferred until eligibility,
permissions, secure token lifecycle and a complete conforming implementation can
be reviewed and verified. No borrowed client IDs or existing application tokens
may be used.

## MCP OAuth

[MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
defines client registration, HTTPS metadata, resource-bound tokens, S256 PKCE,
state validation and protected token storage. Protocol support is not proof that
an individual service permits an arbitrary third-party client. No target service
or approved client registration was supplied, so generic discovery, registration
and login are deferred in this change. A future implementation requires reviewing
the chosen service's published terms and client policy, authorized registration,
minimum scopes, secure redirect/discovery handling, token refresh/revocation, and
the specification's security requirements. Existing tokens from other clients
must not be collected or passed through.
