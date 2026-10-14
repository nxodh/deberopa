import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { expandTemplate, getCommand, listCommands, runCommand, splitArguments, CommandNotFoundError } from "../src/command/command"
import { resetCommands } from "../src/command/command"
import { createSession } from "../src/session/store"
import { mockConfig, reply, startMockLLM, tmpDir, useProject, type MockLLM, endProject } from "./helpers"
import { detectShell, run } from "../src/util/shell"

let mock: MockLLM
let dir: string

beforeAll(() => {
  mock = startMockLLM()
})
afterAll(() => mock.stop())
beforeEach(() => {
  dir = tmpDir()
  mock.reset()
  resetCommands()
})

test("argument splitting keeps quoted phrases together", () => {
  expect(splitArguments(`one "two words" 'three four' five`)).toEqual(["one", "two words", "three four", "five"])
})

test("template placeholders", async () => {
  expect(await expandTemplate("Fix $ARGUMENTS now", "the bug in x")).toBe("Fix the bug in x now")
  expect(await expandTemplate("a=$1 b=$2", `first "second arg"`)).toBe("a=first b=second arg")
  // the last placeholder takes the rest
  expect(await expandTemplate("a=$1 rest=$2", "x y z")).toBe("a=x rest=y z")
  // without placeholders the arguments are appended
  expect(await expandTemplate("Do the thing", "extra context")).toBe("Do the thing\n\nextra context")
  expect(await expandTemplate("Do the thing", "")).toBe("Do the thing")
})

test("shell output injection runs in the project directory", async () => {
  fs.writeFileSync(path.join(dir, "marker.txt"), "x")
  const out = await expandTemplate("Files: !`echo hello-from-shell`", "", dir, async (command) => {
    const shell = detectShell()
    return (await run(shell.path, [...shell.args, command], { cwd: dir })).stdout
  })
  expect(out).toBe("Files: hello-from-shell")
  await expect(expandTemplate("!`echo never`", "", dir)).rejects.toThrow("permission checks")
})

test("commands load from config, command/*.md (nested) and built-ins", async () => {
  fs.mkdirSync(path.join(dir, ".deberopa", "command", "git"), { recursive: true })
  fs.writeFileSync(
    path.join(dir, ".deberopa", "command", "test.md"),
    "---\ndescription: run tests\nagent: plan\nmodel: mock/mock-1\nsubtask: true\n---\nRun the tests for $ARGUMENTS\n",
  )
  fs.writeFileSync(path.join(dir, ".deberopa", "command", "git", "summary.md"), "Summarise recent commits\n")
  useProject(dir, mockConfig(mock, { command: { hello: { template: "Say hello to $1", description: "greet" } } }))
  const all = await listCommands()
  expect(Object.keys(all).sort()).toEqual(["git/summary", "hello", "init", "review", "test"])
  expect(all.test).toMatchObject({ description: "run tests", agent: "plan", subtask: true, model: { providerID: "mock", modelID: "mock-1" } })
  expect(all.test!.template).toBe("Run the tests for $ARGUMENTS")
  expect(all.hello!.source).toBe("config")
  expect((await getCommand("init"))!.template).toContain("AGENTS.md")
})

test("running a command sends the expanded prompt and resolves @file mentions", async () => {
  fs.writeFileSync(path.join(dir, "data.txt"), "secret-content-123")
  useProject(dir, mockConfig(mock, { command: { explain: { template: "Explain @data.txt to $1" } } }))
  const s = await createSession()
  mock.queue(reply.text("explained"))
  const result = await runCommand({ sessionID: s.id, name: "explain", arguments: "a beginner" })
  expect(result).toBeDefined()
  const user = mock.requests[0].messages.filter((m: any) => m.role === "user").map((m: any) => m.content).join("\n")
  expect(user).toContain("Explain @data.txt to a beginner")
  expect(user).toContain("secret-content-123")
  await expect(runCommand({ sessionID: s.id, name: "nope" })).rejects.toBeInstanceOf(CommandNotFoundError)
})

test("subtask commands tell the model to delegate", async () => {
  useProject(dir, mockConfig(mock, { command: { dig: { template: "Dig into $ARGUMENTS", agent: "explore", subtask: true } } }))
  const s = await createSession()
  mock.queue(reply.text("delegating"))
  await runCommand({ sessionID: s.id, name: "dig", arguments: "the cache" })
  const user = mock.requests[0].messages.filter((m: any) => m.role === "user").map((m: any) => m.content).join("\n")
  expect(user).toContain('subagent_type "explore"')
  expect(user).toContain("Dig into the cache")
})

afterAll(endProject)
