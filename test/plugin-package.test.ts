import { afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { installPackage, packageDir, packageEntry, parsePackage } from "../src/plugin/package"
import { loadPlugins, resetPlugins } from "../src/plugin"
import { endProject, tmpDir, useProject } from "./helpers"

afterAll(endProject)
test("npm plugins reject URLs, ranges, tags and shell syntax", () => {
  for (const spec of ["https://evil.example/x", "file:../x", "x@latest", "x@^1.2.3", "x@1.2.3;echo", "git+https://evil.example/x"]) expect(() => parsePackage(spec)).toThrow("exact version")
  expect(parsePackage("npm:@scope/example@1.2.3")).toEqual({ name: "@scope/example", version: "1.2.3", spec: "@scope/example@1.2.3" })
})
test("an explicit install pins the version, disables scripts, and loads the package's export", async () => {
  const spec = "fixture-plugin@1.2.3"
  const dir = packageDir(spec)
  let args: string[] = []
  await installPackage(spec, async (command) => {
    args = command
    const root = path.join(dir, "node_modules", "fixture-plugin")
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(path.join(dir, "package-lock.json"), "{}")
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture-plugin", version: "1.2.3", type: "module", exports: "./index.js" }))
    await fs.writeFile(path.join(root, "index.js"), "export default () => ({ tool: { fixture: { description: 'fixture', execute: () => 'ok' } } })")
    return { code: 0, stdout: "", stderr: "" }
  })
  expect(args).toContain("--ignore-scripts")
  expect(args).toContain("--save-exact")
  expect(args).toContain("--package-lock=true")
  useProject(tmpDir(), { plugin: ["npm:" + spec] })
  resetPlugins()
  expect((await loadPlugins())[0]?.hooks.tool?.fixture).toBeDefined()
  await fs.writeFile(path.join(dir, "node_modules", "fixture-plugin", "package.json"), JSON.stringify({ name: "fixture-plugin", version: "9.9.9" }))
  await expect(packageEntry(spec)).rejects.toThrow("identity")
  await fs.rm(dir, { recursive: true, force: true })
})
