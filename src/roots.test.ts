import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { run } from "./program.js"

const ran = async (argv: string[]) => {
  const out: string[] = []
  const err: string[] = []
  const code = await run(argv, {
    streams: { data: (text) => out.push(text), diagnostic: (text) => err.push(text) },
    tty: false,
  })
  return { code, out: out.join("\n"), err: err.join("\n") }
}

it.each([
  ["--verbose"],
  ["--quiet"],
  ["--trace"],
  ["--debug"],
  ["--timeout", "30s"],
  ["--offline"],
  ["--no-input"],
  ["--max-input-bytes", "1024"],
  ["--max-output-bytes", "0"],
  ["--brief"],
  ["--full"],
  ["--yes"],
  ["--record"],
  ["--no-record"],
])("doctor runs with the global option %s", async (...flag) => {
  const { code, out } = await ran([...flag, "doctor", "--json"])
  expect(code).toBe(0)
  expect(JSON.parse(out).item.version).toEqual(expect.any(String))
})

it("--jsonl prints one object per line", async () => {
  const { code, out } = await ran(["--jsonl", "personal", "config", "show"])
  expect(code).toBe(0)
  for (const line of out.split("\n").filter(Boolean)) expect(() => JSON.parse(line)).not.toThrow()
})

it("--dry-run previews a write without making it", async () => {
  const { code } = await ran(["--dry-run", "personal", "config", "set", "limit", "5", "--json"])
  expect(code).toBe(0)
  const { out } = await ran(["personal", "config", "show", "--json"])
  expect(JSON.parse(out).item.settings).toContainEqual(expect.objectContaining({ setting: "limit", value: 20 }))
})

it("config set and unset change one setting and put it back", async () => {
  for (const scope of [[], ["--defaults"], ["--personal"], ["--bot"]]) {
    expect((await ran(["personal", "config", "set", "limit", "7", ...scope, "--json"])).code).toBe(0)
    expect((await ran(["personal", "config", "unset", "limit", ...scope, "--json"])).code).toBe(0)
  }
})

it("config show --bot shows what a bot command would get", async () => {
  const { code, out } = await ran(["personal", "config", "show", "--bot", "--json"])
  expect(code).toBe(0)
  expect(JSON.parse(out).item.profile).toBe("personal")
})

it("commands info exports the schemas and reasons", async () => {
  const { code, out } = await ran(["commands", "info", "--json"])
  expect(code).toBe(0)
  expect(out.length).toBeGreaterThan(0)
})

it("skill install writes the skill for Claude Code", async () => {
  const { code } = await ran(["skill", "install", "--for", "claude", "--json"])
  expect(code).toBe(0)
  expect(existsSync(join(homedir(), ".claude", "skills", "mail-cli", "SKILL.md"))).toBe(true)
})

it("skill status and skill show --for read what skill install wrote", async () => {
  expect((await ran(["skill", "install", "--for", "claude", "--json"])).code).toBe(0)
  const status = await ran(["skill", "status", "--json"])
  expect(status.code).toBe(0)
  expect(JSON.parse(status.out).item.targets).toEqual([
    expect.objectContaining({ target: "claude", state: "current" }),
    expect.objectContaining({ target: "agents", installed: null, state: "missing" }),
  ])
  const shown = await ran(["skill", "show", "--for", "claude", "--json"])
  expect(shown.code).toBe(0)
  expect(JSON.parse(shown.out).item).toMatchObject({
    target: "claude",
    content: expect.stringContaining("name: mail-cli"),
  })
})

it("help prints the first screen", async () => {
  const { code, out } = await ran(["help"])
  expect(code).toBe(0)
  expect(out).toContain("mail")
})
