import { afterAll, expect, test } from "bun:test"
import path from "node:path"
import { startServer } from "../src/server/server"
import { which } from "../src/util/shell"
import { endProject, mockConfig, reply, startMockLLM, tmpDir, useProject } from "./helpers"

afterAll(endProject)
test("Python SDK uses the real HTTP API, authentication and event stream", async () => {
  const python = which("python3") ?? which("python")
  if (!python) throw new Error("Python 3.10+ is required for SDK integration tests")
  const mock = startMockLLM()
  useProject(tmpDir(), mockConfig(mock))
  const server = startServer({ port: 0, password: "fixture-password" })
  mock.queue(reply.text("hello from mock"))
  const script = `
import os
from vedecaps import Client, VedecapsError, message_text
url = os.environ["SDK_TEST_URL"]
client = Client(url, password="fixture-password")
assert client.health()["ok"]
try:
    Client(url).health()
    raise AssertionError("authentication bypass")
except VedecapsError as e:
    assert e.status == 401
events = client.events()
assert next(events)["type"] == "server.connected"
events.close()
session = client.session.create(title="Python integration")
answer = client.session.prompt(session["id"], "hello")
assert message_text(answer) == "hello from mock"
assert len(client.session.messages(session["id"])) == 2
assert "hello from mock" in client.session.export(session["id"])
client.session.update(session["id"], "renamed")
assert client.session.get(session["id"])["title"] == "renamed"
client.session.delete(session["id"])
print("python SDK passed")
`
  try {
    const proc = Bun.spawn([python, "-c", script], { env: { ...process.env, PYTHONPATH: path.join(process.cwd(), "sdk", "python"), SDK_TEST_URL: `http://127.0.0.1:${server.port}` }, stdout: "pipe", stderr: "pipe" })
    const code = await proc.exited
    const stderr = await new Response(proc.stderr).text()
    expect(stderr).toBe("")
    expect(code).toBe(0)
  } finally { server.stop(true); mock.stop() }
}, 20_000)
