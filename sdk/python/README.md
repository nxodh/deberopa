# Python SDK

Python 3.10+, with no runtime dependencies. Install from this checkout:

```sh
python -m pip install ./sdk/python
```

```python
from vedecaps import Client, message_text, start_server

with start_server(cwd="path/to/project") as server:
    session = server.client.session.create(title="Notes")
    reply = server.client.session.prompt(session["id"], "Explain README.md")
    print(message_text(reply))
```

Use `Client(base_url, password=...)` for an existing server. Remote connections
require HTTPS. `client.events()` yields SSE events; close its generator to release
the connection. Listen for `permission.asked` and use `client.permission.reply()`
to approve or reject requests. `prompt_async()` returns immediately so the same
thread can consume progress and permission events. Every HTTP endpoint is also
accessible with `client.request(method, path, body)`. Errors expose `status` and
`body` through `VedecapsError`. Not published to PyPI.
