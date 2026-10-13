import { expect, test } from "bun:test"
import { assetPattern, safeArchiveNames } from "../src/lsp/download"

test("only official platform-specific asset names match", () => {
  expect(assetPattern("clangd", "win32", "x64").test("clangd-windows-23.1.0.zip")).toBe(true)
  expect(assetPattern("clangd", "linux", "x64").test("clangd-debug-symbols-linux-23.1.0.zip")).toBe(false)
  expect(() => assetPattern("clangd", "linux", "arm64")).toThrow("no")
  expect(assetPattern("zls", "darwin", "arm64").test("zls-aarch64-macos.tar.xz")).toBe(true)
  expect(assetPattern("lua-language-server", "win32", "x64").test("lua-language-server-3.19.2-win32-x64.zip")).toBe(true)
})
test("archives cannot escape their installation directory", () => {
  expect(safeArchiveNames("./bin/server\nLICENSE\n")).toBe(true)
  for (const names of ["../escape", "/escape", "root/../../escape", "C:/escape", "root\\escape", ""]) expect(safeArchiveNames(names)).toBe(false)
})
