import { afterAll, beforeAll, expect, test } from "bun:test"
import { assetName, compareVersions, isCompiled, latestVersion, targetName, upgrade, UpdateError } from "../src/update/update"

let server: ReturnType<typeof Bun.serve>
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/latest") return new Response(null, { status: 302, headers: { location: "https://example.invalid/owner/repo/releases/tag/v1.4.2" } })
      return new Response("not found", { status: 404 })
    },
  })
  process.env.VEDECAPS_RELEASE_URL = `http://127.0.0.1:${server.port}`
})
afterAll(() => {
  delete process.env.VEDECAPS_RELEASE_URL
  server.stop(true)
})

test("version comparison", () => {
  expect(compareVersions("0.1.1", "0.1.0")).toBeGreaterThan(0)
  expect(compareVersions("v0.2.0", "0.10.0")).toBeLessThan(0)
  expect(compareVersions("1.0.0", "1.0.0")).toBe(0)
  expect(compareVersions("1.0", "1.0.0")).toBe(0)
})

test("release asset names per platform", () => {
  expect(assetName(targetName("linux", "x64"))).toBe("vedecaps-linux-x64.tar.gz")
  expect(assetName(targetName("linux", "arm64"))).toBe("vedecaps-linux-arm64.tar.gz")
  expect(assetName(targetName("win32", "x64"))).toBe("vedecaps-windows-x64.zip")
  expect(assetName(targetName("darwin", "arm64"))).toBe("vedecaps-darwin-arm64.tar.gz")
  expect(() => targetName("freebsd" as NodeJS.Platform, "x64")).toThrow(UpdateError)
  expect(() => targetName("win32", "arm64")).toThrow(UpdateError)
})

test("latest version comes from the release redirect", async () => {
  expect(await latestVersion()).toBe("1.4.2")
})

test("a source checkout refuses to self-replace", async () => {
  expect(isCompiled()).toBe(false)
  expect(upgrade()).rejects.toThrow(UpdateError)
})
