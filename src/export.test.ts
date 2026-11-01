import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { memoryKeyring } from "@wirecat/cli-base"
import { afterEach, describe, expect, it } from "vitest"
import type { MailEnvironment } from "./commands/context.js"
import { INFO_SEPARATOR } from "./export/format.js"
import type { MailEndpoint, RunBounds } from "./mail/backend.js"
import { imapBackend } from "./mail/imap/index.js"
import { run } from "./program.js"
import { type FakeImap, startFakeImap } from "./testing/fake-imap.js"

const PASSWORD = "fixture-app-password-4Rt9"
const ADDRESS = "me@example.com"

const raw = (id: string, subject: string, body: string, date = "Tue, 27 Oct 2026 10:00:00 +0000") =>
  `Message-ID: <${id}@example.com>\r\nDate: ${date}\r\nFrom: Ann <ann@example.com>\r\nTo: ${ADDRESS}\r\n` +
  `Subject: ${subject}\r\n\r\n${body}\r\n`

const MAILS = {
  invoice: raw("invoice", "Invoice October", "Please pay.\r\nFrom here on it is due.\r\n>From a quote"),
  lunch: raw("lunch", "Lunch", "Noon?", "Wed, 28 Oct 2026 10:00:00 +0000"),
  trip: raw("trip", "Trip plan", "Train at nine.", "Thu, 29 Oct 2026 10:00:00 +0000"),
  sent: raw("sent", "Sent invoice", "Here it is.", "Fri, 30 Oct 2026 10:00:00 +0000"),
}

let fake: FakeImap | undefined
afterEach(async () => {
  await fake?.close()
  fake = undefined
})

const crowd = (count: number) =>
  Array.from({ length: count }, (_, at) => ({
    uid: at + 1,
    raw: raw(`m${at}`, `Mail ${at}`, `Body ${at}`, "Tue, 27 Oct 2026 10:00:00 +0000"),
    flags: [] as string[],
    date: "27-Oct-2026 10:00:00 +0000",
  }))

const setup = async (crowded = 0) => {
  fake = await startFakeImap({
    login: ADDRESS,
    password: PASSWORD,
    capabilities: ["CONDSTORE"],
    folders: [
      {
        name: "INBOX",
        messages: crowded
          ? crowd(crowded)
          : [
              { uid: 1, raw: MAILS.invoice, flags: ["\\Seen", "\\Flagged"], date: "27-Oct-2026 10:00:00 +0000" },
              { uid: 2, raw: MAILS.lunch, flags: [], date: "28-Oct-2026 10:00:00 +0000" },
              { uid: 3, raw: MAILS.trip, flags: ["\\Seen"], date: "29-Oct-2026 10:00:00 +0000" },
            ],
      },
      {
        name: "Sent",
        attributes: ["\\Sent"],
        messages: [{ uid: 1, raw: MAILS.sent, flags: ["\\Seen"], date: "30-Oct-2026 10:00:00 +0000" }],
      },
    ],
  })
  const port = fake.port
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MAIL_CONFIG_DIR: mkdtempSync(join(tmpdir(), "config-")),
    MAIL_STATE_DIR: mkdtempSync(join(tmpdir(), "state-")),
    MESSAGING_STORE: join(mkdtempSync(join(tmpdir(), "store-")), "wirecat.db"),
  }
  delete env.CI
  const keyring = memoryKeyring()
  const mail = async (argv: string[], password?: string) => {
    const out: string[] = []
    const err: string[] = []
    const options: MailEnvironment & Record<string, unknown> = {
      streams: { data: (text) => out.push(text), diagnostic: (text) => err.push(text) },
      tty: false,
      env: password === undefined ? env : { ...env, MAIL_PASSWORD: password },
      keyring,
      himalaya: async () => undefined,
      discovery: { mx: async () => ["mx.yandex.net"], fetch: async () => new Response("", { status: 404 }) },
      backend: (endpoint: MailEndpoint, secret: string, bounds: RunBounds = {}) =>
        imapBackend({ ...endpoint, host: "127.0.0.1", port, security: "plain" }, secret, {
          sleep: async () => {},
          ...bounds,
        }),
    }
    const code = await run(argv, options)
    return { code, out: out.join("\n"), err: err.join("\n") }
  }
  expect((await mail(["ya", "session", "start", "--address", ADDRESS, "--json"], PASSWORD)).code).toBe(0)
  expect((await mail(["ya", "session", "end", "--json"])).code).toBe(0)
  expect((await mail(["ya", "session", "start", "--json"], PASSWORD)).code).toBe(0)
  expect((await mail(["ya", "sync", "--since-time", "2026-10-01", "--json"])).code).toBe(0)
  const exported = async (...argv: string[]) => {
    const answer = await mail(["ya", "messages", "export", ...argv, "--json"])
    return { ...answer, item: answer.out ? JSON.parse(answer.out).item : undefined }
  }
  return { mail, exported }
}

const folderOf = () => mkdtempSync(join(tmpdir(), "export-"))
// Windows ignores POSIX modes (WC-SECR-10).
const mode = (path: string, wanted: number) => (process.platform === "win32" ? wanted : statSync(path).mode & 0o777)

describe("messages export", () => {
  it("writes the original bytes of the matching mail to one private mbox per folder, mboxrd-escaped", async () => {
    const { exported } = await setup()
    const out = join(folderOf(), "backup")
    const answer = await exported("invoice", "--output", out)
    expect(answer.code, answer.err).toBe(0)
    expect(answer.item).toMatchObject({ format: "mbox", matched: 2, exported: 2, complete: true, unreadable: 0 })

    expect(readdirSync(out).sort()).toEqual([".mail-export.jsonl", "INBOX.mbox", "Sent.mbox"])
    expect(mode(out, 0o700)).toBe(0o700)
    expect(mode(join(out, "INBOX.mbox"), 0o600)).toBe(0o600)
    expect(mode(join(out, ".mail-export.jsonl"), 0o600)).toBe(0o600)

    const inbox = readFileSync(join(out, "INBOX.mbox"), "latin1")
    expect(inbox).toMatch(/^From MAILER-DAEMON Tue Oct 27 10:00:00 2026\r\nMessage-ID: <invoice@example.com>/)
    expect(inbox).toContain("\r\n>From here on it is due.")
    expect(inbox).toContain("\r\n>>From a quote")
    expect(inbox).not.toContain("Lunch")
    expect(readFileSync(join(out, "Sent.mbox"), "latin1")).toContain("Subject: Sent invoice")
  })

  it("writes a Maildir++ tree with the read and starred state in the file names", async () => {
    const { exported } = await setup()
    const out = join(folderOf(), "Maildir")
    const answer = await exported("--format", "maildir", "--output", out)
    expect(answer.item).toMatchObject({ format: "maildir", exported: 4, complete: true })
    expect(readdirSync(out).sort()).toEqual([".Sent", ".mail-export.jsonl", "cur", "new", "tmp"])
    const names = readdirSync(join(out, "cur")).sort()
    expect(names).toHaveLength(3)
    expect(names.map((name) => name.split(`${INFO_SEPARATOR}2,`)[1]).sort()).toEqual(["", "FS", "S"])
    const flagged = names.find((name) => name.endsWith(`${INFO_SEPARATOR}2,FS`)) as string
    expect(readFileSync(join(out, "cur", flagged), "latin1")).toBe(MAILS.invoice)
    expect(mode(join(out, "cur", flagged), 0o600)).toBe(0o600)
    expect(readdirSync(join(out, ".Sent", "cur"))).toHaveLength(1)
    expect(readdirSync(join(out, "tmp"))).toEqual([])
  })

  it("stops at --limit, newest first, and --resume writes the rest without repeating a message", async () => {
    const { exported } = await setup()
    const out = join(folderOf(), "backup")
    const first = await exported("--folder", "INBOX", "--limit", "2", "--output", out)
    expect(first.item).toMatchObject({ exported: 2, state: "partial", stopped: "limit", complete: false })
    expect(readFileSync(join(out, "INBOX.mbox"), "latin1")).not.toContain("Invoice October")

    const second = await exported("--folder", "INBOX", "--resume", "--output", out)
    expect(second.item).toMatchObject({ exported: 1, already_exported: 2, state: "complete", complete: true })
    const inbox = readFileSync(join(out, "INBOX.mbox"), "latin1")
    expect(inbox.match(/^From MAILER-DAEMON/gm)).toHaveLength(3)

    const third = await exported("--folder", "INBOX", "--resume", "--output", out)
    expect(third.item).toMatchObject({ exported: 0, already_exported: 3, complete: true })
  })

  it("stops at --max-pages after a slice of 50, and --resume writes the next slice", async () => {
    const { exported } = await setup(120)
    const out = join(folderOf(), "backup")
    const first = await exported("--folder", "INBOX", "--max-pages", "1", "--output", out)
    expect(first.item).toMatchObject({ exported: 50, state: "partial", stopped: "requests", complete: false })
    expect(first.item.hint).toContain("--resume")
    const second = await exported("--folder", "INBOX", "--resume", "--output", out)
    expect(second.item).toMatchObject({ exported: 70, already_exported: 50, complete: true })
    expect(readFileSync(join(out, "INBOX.mbox"), "latin1").match(/^From MAILER-DAEMON/gm)).toHaveLength(120)
  })

  it("cuts a half-written message after a crash before it goes on", async () => {
    const { exported } = await setup()
    const out = join(folderOf(), "backup")
    await exported("--folder", "INBOX", "--limit", "1", "--output", out)
    writeFileSync(join(out, "INBOX.mbox"), "From MAILER-DAEMON torn", { flag: "a" })
    await exported("--folder", "INBOX", "--resume", "--output", out)
    const inbox = readFileSync(join(out, "INBOX.mbox"), "latin1")
    expect(inbox).not.toContain("torn")
    expect(inbox.match(/^From MAILER-DAEMON/gm)).toHaveLength(3)
  })

  it("never writes into a folder that has something in it without --resume or --replace", async () => {
    const { exported } = await setup()
    const taken = folderOf()
    writeFileSync(join(taken, "mine.txt"), "keep")
    const refused = await exported("--output", taken)
    expect(refused.code).toBe(2)
    expect(refused.err + refused.out).toContain("--replace")
    expect(readFileSync(join(taken, "mine.txt"), "utf8")).toBe("keep")

    const replaced = await exported("--folder", "INBOX", "--replace", "--output", taken)
    expect(replaced.item).toMatchObject({ exported: 3 })
    expect(readFileSync(join(taken, "mine.txt"), "utf8")).toBe("keep")

    const again = await exported("--folder", "INBOX", "--output", taken)
    expect(again.err + again.out).toContain("--resume")
    mkdirSync(join(taken, "x"), { recursive: true })
    const nothing = await exported("--resume", "--output", join(folderOf(), "none"))
    expect(nothing.code).not.toBe(0)
  })
})

describe("stats messages top", () => {
  it("groups the stored mail by sender, list or domain, biggest first", async () => {
    const { mail } = await setup()
    const by = async (group: string) => {
      const answer = await mail(["ya", "stats", "messages", "top", "--by", group, "--limit", "5", "--json"])
      expect(answer.code, answer.err).toBe(0)
      return JSON.parse(answer.out).items
    }
    expect((await by("sender"))[0]).toMatchObject({ group: "ann@example.com", emails: 4, unread: 1 })
    expect((await by("domain"))[0]).toMatchObject({ group: "example.com", emails: 4 })
    expect(await by("list")).toEqual([])
  })
})
