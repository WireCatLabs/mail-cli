import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { resolvePaths } from "@wirecat/cli-base"
import { appDoctorReport } from "@wirecat/cli-core/cli"
import { expect, it } from "vitest"
import { configuration } from "./config.js"
import { IDENTITY } from "./identity.js"
import { createProgram, run } from "./program.js"

const ran = async (argv: string[], fetch?: typeof globalThis.fetch) => {
  const out: string[] = []
  const err: string[] = []
  const code = await run(argv, {
    streams: { data: (text) => out.push(text), diagnostic: (text) => err.push(text) },
    tty: false,
    ...(fetch ? { fetch } : {}),
  })
  return { code, out: out.join("\n"), err: err.join("\n") }
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const json = (text: string) => {
  const parsed: unknown = JSON.parse(text)
  if (!isRecord(parsed) || !isRecord(parsed.item)) throw new Error(`not an answer with one item: ${text}`)
  return { item: parsed.item }
}

it("lists the required root commands and config", async () => {
  const { code, out } = await ran(["commands", "--json"])
  expect(code).toBe(0)
  const required = ["commands", "doctor", "skill", "mcp", "upgrade", "config", "runs"]
  expect(JSON.parse(out).commands).toEqual(
    expect.arrayContaining(required.map((name) => expect.objectContaining({ name }))),
  )
})

it("doctor answers without a config file", async () => {
  const { code, out } = await ran(["doctor", "--json"])
  expect(code).toBe(0)
  expect(json(out).item).toMatchObject({ config: { found: false, issues: [] }, profiles: [], read_only: null })
})

it("doctor --online says whether a newer version is published, and does not log in", async () => {
  const published = (async () => Response.json({ version: "99.0.0" })) as unknown as typeof fetch
  const { code, out } = await ran(["doctor", "--online", "--json"], published)
  expect(code).toBe(0)
  expect(json(out).item.online).toMatchObject({
    ok: true,
    version: { current: IDENTITY.version, latest: "99.0.0", newer: true },
  })
})

const withConfig = async (text: string, check: (config: unknown) => void) => {
  const dir = process.env.MAIL_CONFIG_DIR ?? ""
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "config.json"), text)
  try {
    const { code, out } = await ran(["doctor", "--json"])
    expect(code).toBe(0)
    check(json(out).item.config)
  } finally {
    rmSync(join(dir, "config.json"))
  }
}

it("doctor reports invalid JSON as an issue", async () => {
  await withConfig('{\n  "defaults": {\n', (config) =>
    expect(config).toMatchObject({ found: true, issues: [{ kind: "invalid_json", line: 3 }] }),
  )
})

it("doctor reports an unknown setting with the command that removes it", async () => {
  await withConfig('{ "defaults": { "limt": 3 } }', (config) =>
    expect(config).toMatchObject({
      found: true,
      issues: [{ kind: "unknown_setting", key: "limt", fix: "mail config unset --defaults limt" }],
    }),
  )
})

it("doctor reports settings an environment variable breaks, and still answers", () => {
  const { report } = appDoctorReport(
    IDENTITY,
    configuration,
    { ...process.env, MAIL_EMBEDDING_DIMS: "many" },
    createProgram(),
  )
  expect(report).toMatchObject({ config: { issues: [] }, settings: { error: expect.any(String) }, profiles: null })
})

it.skipIf(process.platform === "win32")(
  "doctor names a config file and folder others can read, with the chmod that fixes each",
  async () => {
    const dir = process.env.MAIL_CONFIG_DIR ?? ""
    const file = join(dir, "config.json")
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, "{}")
    chmodSync(file, 0o644)
    chmodSync(dir, 0o775)
    try {
      const { code, out, err } = await ran(["doctor", "--json"])
      expect(code).toBe(0)
      expect(json(out).item.files).toEqual({
        checked: true,
        ok: false,
        problems: [
          { path: file, mode: "0644", want: "0600" },
          { path: dir, mode: "0775", want: "0700" },
        ],
      })
      expect(err).toContain(`to make it private: chmod 600 '${file}'`)
      expect(err).toContain(`to make it private: chmod 700 '${dir}'`)

      chmodSync(dir, 0o700)
      expect((await ran(["personal", "config", "set", "--defaults", "limit", "5"])).code).toBe(0)
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(json((await ran(["doctor", "--json"])).out).item.files).toEqual({ checked: true, ok: true, problems: [] })
    } finally {
      rmSync(file)
    }
  },
)

it("config show names the profile it was given", async () => {
  const { code, out } = await ran(["personal", "config", "show", "--json"])
  expect(code).toBe(0)
  expect(json(out).item).toMatchObject({ profile: "personal", profile_from: "first word" })
})

it("skill show prints the packaged skill", async () => {
  const { code, out } = await ran(["skill", "show"])
  expect(code).toBe(0)
  expect(out).toContain(readFileSync(new URL("../skills/mail-cli/SKILL.md", import.meta.url), "utf8").split("\n")[0])
})

it("mcp serve without a profile stops and says so", async () => {
  const { code, err } = await ran(["mcp", "serve", "--json"])
  expect(code).toBe(2)
  expect(err).toContain("validation_error")
})

it("mcp alone only names its commands", async () => {
  const { code, err } = await ran(["personal", "mcp", "--json"])
  expect(code).toBe(2)
  expect(err).toContain("--help")
})

it("upgrade --check installs nothing when npm cannot be reached", async () => {
  const { code, out } = await ran(["upgrade", "--check", "--json"])
  expect(code).toBe(0)
  expect(json(out).item).toMatchObject({ current: IDENTITY.version, latest: null, updated: false })
})

it("keeps a failed command as a run, and runs list, show and path read it back", async () => {
  expect((await ran(["--no-such-flag"])).code).toBe(2)
  const listed = await ran(["runs", "list", "--limit", "5", "--page", "1", "--json"])
  expect(listed.code).toBe(0)
  const failed: unknown = JSON.parse(listed.out).items.find((run: { status: string }) => run.status === "failed")
  if (!isRecord(failed) || typeof failed.run_id !== "string") throw new Error(`no failed run in ${listed.out}`)
  const id = failed.run_id
  const shown = await ran(["runs", "show", id, "--json"])
  expect(shown.code).toBe(0)
  expect(shown.out).toContain(id)
  expect((await ran(["runs", "show", id, "--problems", "--json"])).code).toBe(0)
  const path = await ran(["runs", "path", id])
  expect(path.code).toBe(0)
  expect(path.out).toContain(id)
})

it("a failed run keeps the words typed, and record_input false masks them", async () => {
  const keptArgv = async (words: string) => {
    expect((await ran(["personal", "skill", "show", words])).code).toBe(2)
    const { out } = await ran(["runs", "list", "--limit", "50", "--json"])
    return JSON.parse(out).items.map((run: { argv: string[] }) => run.argv)
  }
  expect(await keptArgv("weekly report")).toContainEqual(["personal", "skill", "show", "weekly report"])
  expect((await ran(["personal", "config", "set", "record_input", "false"])).code).toBe(0)
  try {
    const masked = await keptArgv("monthly report")
    expect(JSON.stringify(masked)).not.toContain("monthly report")
    expect(masked).toContainEqual(["personal", "skill", "show", "[redacted]"])
  } finally {
    expect((await ran(["personal", "config", "unset", "record_input"])).code).toBe(0)
  }
})

it("schedules a profile's sync on a timer and lists it", async () => {
  const calls: string[][] = []
  const system = {
    platform: "linux" as const,
    uid: 1000,
    entry: ["/opt/node", "/opt/mail/mail.js"],
    run: async (argv: string[]) => (calls.push(argv), { code: 0, stdout: "", stderr: "" }),
    spawn: () => 0,
    pause: async () => {},
  }
  const out: string[] = []
  const options = { streams: { data: (text: string) => out.push(text), diagnostic: () => {} }, tty: false, system }
  const added = await run(["ya", "schedule", "command", "mail-ya", "--every", "5m", "--", "sync"], options)
  expect(added).toBe(0)
  expect(calls.length).toBeGreaterThan(0)
  out.length = 0
  expect(await run(["ya", "schedule", "list", "--json"], options)).toBe(0)
  expect(JSON.parse(out.join("")).items).toEqual([{ name: "mail-ya", kind: "command", when: "every 5m", last: null }])
})

it("runs the argv of a generated unit with no profile named", async () => {
  const entry = [process.execPath, "-e", "console.log(process.env.MAIL_PROFILE)"]
  const system = {
    platform: "linux" as const,
    uid: 1000,
    entry,
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    spawn: () => 0,
    pause: async () => {},
  }
  const streams = { data: () => {}, diagnostic: () => {} }
  const options = { streams, tty: false, system }
  expect(await run(["ya", "schedule", "command", "mail-ya", "--every", "5m", "--", "sync"], options)).toBe(0)

  const unit = readFileSync(
    join(process.env.XDG_CONFIG_HOME ?? "", "systemd", "user", "mail-schedule-mail-ya.service"),
    "utf8",
  )
  const execStart =
    unit
      .split("\n")
      .find((line) => line.startsWith("ExecStart="))
      ?.slice("ExecStart=".length) ?? ""
  const argv = execStart.slice(1, -1).split('" "')
  expect(argv.slice(0, entry.length)).toEqual(entry)

  delete process.env.MAIL_PROFILE
  const err: string[] = []
  const code = await run(argv.slice(entry.length), {
    ...options,
    streams: { ...streams, diagnostic: (t) => err.push(t) },
  })
  expect(code, err.join("")).toBe(0)
  const last = JSON.parse(
    readFileSync(
      join(
        resolvePaths({ appName: IDENTITY.appName, prefix: IDENTITY.envPrefix, env: process.env }).state,
        "schedules",
        "mail-ya",
        "last.json",
      ),
      "utf8",
    ),
  )
  expect(last.exitCode).toBe(0)
})
