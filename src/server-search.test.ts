import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { memoryKeyring } from "@wirecat/cli-base"
import { afterEach, describe, expect, it } from "vitest"
import type { MailEnvironment } from "./commands/context.js"
import type { MailCredential, MailEndpoint, RunBounds } from "./mail/backend.js"
import { imapBackend } from "./mail/imap/index.js"
import { run } from "./program.js"
import { providerFor } from "./providers.js"
import { type FakeFolder, type FakeImap, type FakeOptions, startFakeImap } from "./testing/fake-imap.js"

const PASSWORD = "fixture-app-password-4Rt9"

const raw = (id: string, subject: string, body: string, from = "Ann <ann@example.com>") =>
  `Message-ID: <${id}@example.com>\r\nDate: Tue, 27 Oct 2026 10:00:00 +0000\r\nFrom: ${from}\r\n` +
  `To: me@example.com\r\nSubject: ${subject}\r\n\r\n${body}\r\n`

const figures = Buffer.from(`Quarterly figures ${"x".repeat(400_000)}`).toString("base64")
const big =
  `Message-ID: <big@example.com>\r\nDate: Tue, 27 Oct 2026 10:00:00 +0000\r\nFrom: Ann <ann@example.com>\r\n` +
  `To: me@example.com\r\nSubject: Invoice with figures\r\nMIME-Version: 1.0\r\n` +
  `Content-Type: multipart/mixed; boundary="b1"\r\n\r\n--b1\r\nContent-Type: text/plain\r\n\r\nThe invoice is here.\r\n` +
  `--b1\r\nContent-Type: text/plain; name="figures.txt"\r\nContent-Disposition: attachment; filename="figures.txt"\r\n` +
  `Content-Transfer-Encoding: base64\r\n\r\n${figures}\r\n--b1--\r\n`

let fake: FakeImap | undefined
afterEach(async () => {
  await fake?.close()
  fake = undefined
})

/** A mailbox whose server search answers by subject and body words, as a substring search does. */
const harness = async (
  address: string,
  folders: FakeFolder[],
  capabilities: string[] = [],
  server: Partial<FakeOptions> = {},
) => {
  const byText = (criteria: string, folder: string) => {
    const words = [...criteria.matchAll(/(?:TEXT|X-GM-RAW) (?:"([^"]*)"|(\S+))/g)].flatMap(([, quoted, bare]) =>
      (quoted ?? bare ?? "").split(" ").filter((word) => !word.includes(":")),
    )
    if (!words.length) return undefined
    return (folders.find(({ name }) => name === folder)?.messages ?? [])
      .filter(({ raw }) => words.every((word) => raw.toLowerCase().includes(word.toLowerCase())))
      .map(({ uid }) => uid)
  }
  fake = await startFakeImap(
    Object.assign(server, { login: address, password: PASSWORD, folders, capabilities, search: byText }),
  )
  const port = fake.port
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MAIL_CONFIG_DIR: mkdtempSync(join(tmpdir(), "config-")),
    MAIL_STATE_DIR: mkdtempSync(join(tmpdir(), "state-")),
    MESSAGING_STORE: join(mkdtempSync(join(tmpdir(), "store-")), "wirecat.db"),
  }
  delete env.CI
  const keyring = memoryKeyring()
  const mail = async (argv: string[], extra: Partial<MailEnvironment> = {}) => {
    const out: string[] = []
    const err: string[] = []
    const code = await run(argv, {
      streams: { data: (text) => out.push(text), diagnostic: (text) => err.push(text) },
      tty: false,
      env: argv.includes("start") ? { ...env, MAIL_PASSWORD: PASSWORD } : env,
      keyring,
      himalaya: async () => undefined,
      discovery: { mx: async () => ["mx.yandex.net"], fetch: async () => new Response("", { status: 404 }) },
      backend: (endpoint: MailEndpoint, password: MailCredential, bounds: RunBounds = {}) =>
        imapBackend({ ...endpoint, host: "127.0.0.1", port, security: "plain" }, password, {
          sleep: async () => {},
          ...bounds,
        }),
      ...extra,
    } as MailEnvironment & Record<string, unknown>)
    return { code, out: out.join("\n"), err: err.join("\n") }
  }
  const json = async (argv: string[]) => {
    const answer = await mail([...argv, "--json"])
    expect(answer.code, answer.err).toBe(0)
    return JSON.parse(answer.out)
  }
  expect((await mail(["ya", "session", "start", "--address", address, "--json"])).code).toBe(0)
  const searches = () => (fake as FakeImap).commands.filter((line) => /^UID SEARCH (?!UID |SINCE )/.test(line))
  return { mail, json, searches, fake }
}

/** The connections a run left open, once the ones it closed have had a moment to go. */
const leftOpen = async (server: FakeImap) => {
  for (let tries = 0; tries < 50 && server.connections() > 0; tries++) await new Promise((r) => setTimeout(r, 20))
  return server.connections()
}

const foundIn = (items: { email: { subject: string }; found_in?: string }[]) =>
  items.map(({ email, found_in }) => [email.subject, found_in])

describe("search messages --backend", () => {
  it("asks INBOX, Sent and Archive with UID SEARCH and stores what sync has not read yet", async () => {
    const inbox: FakeFolder = {
      name: "INBOX",
      messages: [{ uid: 1, raw: raw("old", "Invoice for September", "The September invoice."), flags: ["\\Seen"] }],
    }
    const archive: FakeFolder = { name: "Archive", attributes: ["\\Archive"], messages: [] }
    const { mail, json, searches } = await harness("me@example.com", [
      inbox,
      { name: "Sent", attributes: ["\\Sent"], messages: [] },
      archive,
    ])
    const synced = await mail(["ya", "sync", "--since-time", "2026-10-01", "--json"])
    expect(synced.code, synced.err + synced.out).toBe(0)
    archive.messages.push({ uid: 9, raw: raw("new", "Invoice for October", "Счёт за октябрь."), flags: [] })

    const found = await json(["ya", "search", "messages", "invoice", "from:ann", "is:unread"])
    expect(foundIn(found.items)).toEqual([["Invoice for October", "server"]])
    expect(found.meta.complete).toBe(true)
    expect(searches()).toEqual([
      "UID SEARCH TEXT invoice (FROM ann UNSEEN)",
      "UID SEARCH TEXT invoice (FROM ann UNSEEN)",
      "UID SEARCH TEXT invoice (FROM ann UNSEEN)",
    ])
    const stored = await json(["ya", "search", "messages", "invoice", "--backend", "archive"])
    expect(stored.items).toHaveLength(2)
  })

  it("sends Cyrillic as a UTF-8 literal", async () => {
    const inbox: FakeFolder = { name: "INBOX", messages: [] }
    const { mail, json, searches } = await harness("me@example.com", [inbox])
    expect((await mail(["ya", "sync", "--since-time", "2026-10-01", "--json"])).code).toBe(0)
    inbox.messages.push({ uid: 3, raw: raw("ru", "Счёт", "Оплатите счёт."), flags: [] })
    const found = await json(["ya", "search", "messages", "оплатите", "--backend", "server", "--server-time", "20s"])
    expect(foundIn(found.items)).toEqual([["Счёт", "server"]])
    expect(searches()).toEqual(['UID SEARCH CHARSET UTF-8 TEXT "оплатите"'])
  })

  it("asks Gmail once, in All Mail, in its own syntax", async () => {
    const all: FakeFolder = { name: "[Gmail]/All Mail", attributes: ["\\All"], messages: [] }
    const { mail, json, searches } = await harness(
      "me@gmail.com",
      [{ name: "INBOX", messages: [] }, all],
      ["X-GM-EXT-1"],
    )
    expect((await mail(["ya", "sync", "--since-time", "2026-10-01", "--json"])).code).toBe(0)
    all.messages.push({ uid: 5, raw: raw("g", "Invoice", "Your invoice."), flags: ["\\Flagged"] })
    const found = await json([
      "ya",
      "search",
      "messages",
      "invoice is:starred",
      "date>=2026-10-27",
      "--timezone",
      "UTC",
    ])
    expect(foundIn(found.items)).toEqual([["Invoice", "server"]])
    expect(searches()).toEqual(['UID SEARCH X-GM-RAW "invoice after:2026/10/26 is:starred"'])
  })

  it("keeps to the archive under --offline, and messages.server-search=deny turns it off", async () => {
    const { mail, json, searches } = await harness("me@example.com", [{ name: "INBOX", messages: [] }])
    expect((await mail(["ya", "sync", "--json"])).code).toBe(0)
    const offline = await json(["ya", "search", "messages", "invoice", "--offline"])
    expect(offline.meta.complete).toBe(true)
    expect((await mail(["ya", "config", "set", "permissions.messages.server-search", "deny"])).code).toBe(0)
    const denied = await mail(["ya", "search", "messages", "invoice", "--backend", "server", "--json"])
    expect(denied.code).not.toBe(0)
    expect(denied.err).toContain("permission_error")
    expect(searches()).toEqual([])
  })

  it("answers in part within --server-time when SEARCH hangs, and leaves no connection open", async () => {
    const server: Partial<FakeOptions> = {}
    const { mail, fake } = await harness(
      "me@example.com",
      [
        { name: "INBOX", messages: [] },
        { name: "Sent", attributes: ["\\Sent"], messages: [] },
      ],
      [],
      server,
    )
    expect((await mail(["ya", "sync", "--since-time", "2026-10-01", "--json"])).code).toBe(0)
    server.hangSearches = true
    const started = Date.now()
    const answer = await mail([
      "ya",
      "search",
      "messages",
      "invoice",
      "--backend",
      "server",
      "--server-time",
      "1s",
      "--json",
    ])
    expect(answer.code, answer.err).toBe(0)
    expect(Date.now() - started).toBeLessThan(5_000)
    const { meta } = JSON.parse(answer.out)
    expect(meta.complete).toBe(false)
    expect(meta.issues).toEqual([{ code: "timeout", reason: "search.server-timeout", source: "server" }])
    expect(await leftOpen(fake)).toBe(0)
  })

  it("answers a timeout, not a failure, when reading the finds outlasts --server-time", async () => {
    const server: Partial<FakeOptions> = {}
    const inbox: FakeFolder = { name: "INBOX", messages: [] }
    const { mail, fake } = await harness("me@example.com", [inbox], [], server)
    expect((await mail(["ya", "sync", "--since-time", "2026-10-01", "--json"])).code).toBe(0)
    inbox.messages.push({ uid: 3, raw: raw("big", "Invoice", "Invoice."), flags: [] })
    server.hangFetches = true
    const answer = await mail([
      "ya",
      "search",
      "messages",
      "invoice",
      "--backend",
      "server",
      "--server-time",
      "1s",
      "--json",
    ])
    expect(answer.code, answer.err).toBe(0)
    const { meta } = JSON.parse(answer.out)
    expect(meta.issues).toEqual([{ code: "timeout", reason: "search.server-timeout", source: "server" }])
    expect(await leftOpen(fake)).toBe(0)
  })

  it("ends a long --server-time before the command's deadline, answers in part, and writes nothing after", async () => {
    const server: Partial<FakeOptions> = {}
    const inbox: FakeFolder = { name: "INBOX", messages: [] }
    const { mail, json, fake } = await harness("me@example.com", [inbox], [], server)
    expect((await mail(["ya", "sync", "--since-time", "2026-10-01", "--json"])).code).toBe(0)
    for (let uid = 10; uid < 310; uid++)
      inbox.messages.push({ uid, raw: raw(`n${uid}`, `Invoice ${uid}`, "Invoice."), flags: [] })
    server.hangFetches = true
    const started = Date.now()
    const answer = await mail([
      "ya",
      "search",
      "messages",
      "invoice",
      "--backend",
      "server",
      "--server-time",
      "60s",
      "--timeout",
      "7s",
      "--json",
    ])
    expect(Date.now() - started).toBeLessThan(6_500)
    expect(answer.code, answer.err).toBe(0)
    expect(JSON.parse(answer.out).meta.issues).toEqual([
      { code: "timeout", reason: "search.server-timeout", source: "server" },
    ])
    expect(await leftOpen(fake)).toBe(0)
    const commands = fake.commands.length
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    expect(fake.commands.length).toBe(commands)
    expect((await json(["ya", "search", "messages", "invoice", "--backend", "archive"])).items).toEqual([])
  }, 30_000)

  it("counts a folder whose SEARCH is refused as failed, not as empty", async () => {
    const server: Partial<FakeOptions> = {}
    const { mail, fake } = await harness(
      "me@example.com",
      [
        { name: "INBOX", messages: [] },
        { name: "Sent", attributes: ["\\Sent"], messages: [] },
      ],
      [],
      server,
    )
    expect((await mail(["ya", "sync", "--since-time", "2026-10-01", "--json"])).code).toBe(0)
    server.refuseSearches = true
    const answer = await mail(["ya", "search", "messages", "invoice", "--backend", "server", "--json"])
    expect(answer.code, answer.err).toBe(0)
    const { meta } = JSON.parse(answer.out)
    expect(meta.complete).toBe(false)
    expect(meta.issues).toEqual([{ code: "provider_unavailable", reason: "search.server-failed", source: "server" }])
    expect(await leftOpen(fake)).toBe(0)
  })

  it("closes every connection after reading finds from two folders at once", async () => {
    const inbox: FakeFolder = { name: "INBOX", messages: [] }
    const sent: FakeFolder = { name: "Sent", attributes: ["\\Sent"], messages: [] }
    const { mail, json, fake } = await harness("me@example.com", [inbox, sent])
    expect((await mail(["ya", "sync", "--since-time", "2026-10-01", "--json"])).code).toBe(0)
    for (const [folder, id] of [
      [inbox, "a"],
      [sent, "b"],
    ] as const)
      folder.messages.push(
        ...Array.from({ length: 40 }, (_, at) => ({
          uid: at + 1,
          raw: raw(`${id}${at}`, `Invoice ${id}${at}`, "Invoice."),
          flags: [],
        })),
      )
    const found = await json(["ya", "search", "messages", "invoice", "--backend", "server", "--server-time", "20s"])
    expect(found.page.total.value).toBe(80)
    expect(await leftOpen(fake)).toBe(0)
  })
})

describe("the server time of a provider", () => {
  it("gives Yandex 20 s, since one SEARCH of a large INBOX outlasts the 5 s others keep", () => {
    expect(providerFor("ann@yandex.ru", undefined)?.search?.timeMs).toBe(20_000)
    expect(providerFor("ann@gmail.com", undefined)?.search?.timeMs).toBeUndefined()
  })
})

describe("a refused SEARCH and big finds on a real IMAP connection", () => {
  it("syncs a mailbox whose server refuses SEARCH as partial, and marks nothing deleted", async () => {
    const inbox: FakeFolder = {
      name: "INBOX",
      messages: [1, 2, 3, 4, 5, 6].map((uid) => ({ uid, raw: raw(`m${uid}`, `Note ${uid}`, "Words."), flags: [] })),
    }
    const server: Partial<FakeOptions> = {}
    const { mail, json } = await harness("me@example.com", [inbox], [], server)
    expect((await mail(["ya", "sync", "--since-time", "2026-10-01", "--json"])).code).toBe(0)
    inbox.messages.splice(0, 1)
    server.refuseSearches = true

    const answer = await mail(["ya", "sync", "--since-time", "2026-10-01", "--json"])

    expect(answer.code, answer.err).toBe(0)
    const { item, meta } = JSON.parse(answer.out)
    expect(item).toMatchObject({ state: "partial", deleted: 0, refused_folders: ["INBOX"] })
    expect(meta.issues).toContainEqual({ code: "provider_error", reason: "mail.search-refused", source: "sync" })
    server.refuseSearches = false
    expect((await json(["ya", "search", "messages", "note", "--backend", "archive"])).items).toHaveLength(6)
  })

  it("answers one line per hit under --compact", async () => {
    const inbox: FakeFolder = {
      name: "INBOX",
      messages: [{ uid: 1, raw: raw("inv", "Invoice October", "Pay it"), flags: [] }],
    }
    const { mail } = await harness("me@example.com", [inbox])
    expect((await mail(["ya", "sync", "--since-time", "2026-10-01", "--json"])).code).toBe(0)
    const compact = await mail(["ya", "search", "messages", "invoice", "--backend", "archive", "--compact"])
    expect(compact.code, compact.err).toBe(0)
    const lines = compact.out.split("\n").filter((line) => line.startsWith("msg:"))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("Invoice October · Ann")
  })

  it("stores a big find from its first bytes, and the next sync reads it whole", async () => {
    const inbox: FakeFolder = { name: "INBOX", messages: [] }
    const { mail, json, fake: server } = await harness("me@example.com", [inbox])
    expect((await mail(["ya", "sync", "--since-time", "2026-10-01", "--json"])).code).toBe(0)
    inbox.messages.push({ uid: 7, raw: big, flags: [] })

    const found = await json(["ya", "search", "messages", "invoice", "--backend", "server"])
    expect(found.items).toHaveLength(1)
    expect(found.meta.issues).toContainEqual(expect.objectContaining({ reason: "search.server-partial" }))
    expect(server.commands.some((line) => /BODY\.PEEK\[\]<0\.262144>/.test(line))).toBe(true)
    const cut = await json(["ya", "messages", "show", found.items[0].ref])
    expect(cut.item.attachments ?? []).toHaveLength(0)

    expect((await mail(["ya", "sync", "--since-time", "2026-10-01", "--json"])).code).toBe(0)
    const whole = await json(["ya", "messages", "show", found.items[0].ref])
    expect(whole.item.attachments).toEqual([expect.objectContaining({ name: "figures.txt" })])
  })

  it("completes a big Gmail find by its X-GM-MSGID on the next sync, and reads it whole only once", async () => {
    const all: FakeFolder = { name: "[Gmail]/All Mail", attributes: ["\\All"], messages: [] }
    const {
      mail,
      json,
      fake: server,
    } = await harness("me@gmail.com", [{ name: "INBOX", messages: [] }, all], ["X-GM-EXT-1"], { gmail: true })
    const sync = async () => {
      const answer = await mail(["ya", "sync", "--since-time", "2026-10-01", "--json"])
      expect(answer.code, answer.err).toBe(0)
      return JSON.parse(answer.out).item
    }
    await sync()
    const id = "1800000000000000001"
    all.messages.push({ uid: 7, raw: big, flags: [], emailId: id, threadId: id, labels: ["\\Inbox"] })

    const found = await json(["ya", "search", "messages", "invoice", "--backend", "server"])
    expect(found.items).toHaveLength(1)
    expect(found.meta.issues).toContainEqual(expect.objectContaining({ reason: "search.server-partial" }))

    expect((await sync()).partial_emails).toEqual({ completed: 1, left: 0, stuck: 0 })
    const whole = await json(["ya", "messages", "show", found.items[0].ref])
    expect(whole.item.attachments).toEqual([expect.objectContaining({ name: "figures.txt" })])
    expect((await sync()).partial_emails).toBeUndefined()
    expect(server.commands.filter((line) => /UID FETCH 7 .*BODY\.PEEK\[\](?!<)/.test(line))).toHaveLength(1)
  })
})
