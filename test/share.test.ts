import { afterAll, expect, test } from "bun:test"
import { shareHTML, startShareViewer } from "../src/session/share"
import { addMessage, createSession } from "../src/session/store"
import { endProject, tmpDir, useProject } from "./helpers"
import { createID } from "../src/util/id"

afterAll(endProject)
test("sharing escapes executable HTML and excludes private tool output", async () => {
  useProject(tmpDir())
  const session = await createSession()
  await addMessage({ id: createID("message"), sessionID: session.id, role: "user", agent: "build", model: { providerID: "mock", modelID: "m" }, time: { created: 1 }, parts: [
    { id: createID("part"), type: "text", text: '<script>alert(1)</script> password="fixture-private"' },
    { id: createID("part"), type: "text", text: "synthetic-private-file", synthetic: true },
  ] })
  const html = await shareHTML(session.id)
  expect(html).toContain("&lt;script&gt;")
  expect(html).not.toContain("fixture-private")
  expect(html).not.toContain("synthetic-private-file")
  expect(html).not.toContain(session.id)
  const viewer = startShareViewer(html, { ttl: 1 })
  try {
    const response = await fetch(viewer.url)
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'")
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect((await fetch(new URL("/session", viewer.url))).status).toBe(404)
    expect((await fetch(viewer.url, { method: "POST" })).status).toBe(404)
    await viewer.closed
    await expect(fetch(viewer.url)).rejects.toThrow()
  } finally { viewer.close() }
})
test("sharing never exposes a plaintext conversation viewer beyond loopback", () => {
  expect(() => startShareViewer("fixture", { hostname: "0.0.0.0" })).toThrow("HTTPS reverse proxy")
})
