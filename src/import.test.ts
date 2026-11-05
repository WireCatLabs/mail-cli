import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { memoryKeyring } from "@wirecat/cli-base"
import { openStore, storePath } from "@wirecat/cli-core/store"
import { afterEach, describe, expect, it } from "vitest"
import type { MailEnvironment } from "./commands/context.js"
import type { MailCredential, MailEndpoint, RunBounds } from "./mail/backend.js"
import { imapBackend } from "./mail/imap/index.js"
import { run } from "./program.js"
import { type FakeFolder, type FakeImap, startFakeImap } from "./testing/fake-imap.js"
import { ADDRESS, harness, OLD, raw } from "./testing/mailbox.js"

const PASSWORD = "fixture-app-password-9Xw3"
const GMAIL = "me@gmail.com"

let fake: FakeImap | undefined
afterEach(async () => {
  await fake?.close()
  fake = undefined
})

const gmailProfile = async (address: string, folders: FakeFolder[]) => {
  fake = await startFakeImap({
    login: address,
    password: PASSWORD,
    folders,
    capabilities: ["X-GM-EXT-1"],
    gmail: true,
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
  const mail = async (argv: string[]) => {
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
    } as MailEnvironment & Record<string, unknown>)
    return { code, out: out.join("\n"), err: err.join("\n"), item: out.length ? JSON.parse(out.join("")).item : null }
  }
  const started = await mail(["gm", "session", "start", "--address", address, "--json"])
  expect(started.code, started.err).toBe(0)
  const emails = async () => {
    const store = await openStore({ path: storePath(env), env, command: "mail" })
    try {
      const account = await store.accounts.storedAccount({ provider: "email", account: address })
      return (await store.mail.emailFacts({ accountId: account?.id as number })).map((one) => one.externalId).sort()
    } finally {
      await store.close()
    }
  }
  return { mail, emails }
}

const takeout = (entries: { id: string; subject: string; labels: string }[]) => {
  const path = join(mkdtempSync(join(tmpdir(), "takeout-")), "All mail Including Spam and Trash.mbox")
  writeFileSync(
    path,
    entries
      .map(
        ({ id, subject, labels }) =>
          `From ${id}@xxx Mon Jul 24 10:00:00 +0000 2023\nX-GM-THRID: ${id}\nX-Gmail-Labels: ${labels}\n` +
          `Message-ID: <${id}@example.com>\nFrom: Ann <ann@example.com>\nTo: ${GMAIL}\nSubject: ${subject}\n\n` +
          `${subject} body\n\n`,
      )
      .join(""),
  )
  return path
}

describe("messages import", () => {
  it("adds a Takeout file's mail to the Gmail profile once, joined with synced mail by Gmail's id", async () => {
    const synced = "1700000000000000001"
    const all: FakeFolder = {
      name: "[Gmail]/All Mail",
      attributes: ["\\All"],
      messages: [
        {
          uid: 1,
          raw: raw(synced, "Trip plan", "Train at nine."),
          date: "24-Jul-2023 10:00:00 +0000",
          emailId: synced,
          threadId: synced,
          labels: ["\\Inbox"],
        },
      ],
    }
    const { mail, emails } = await gmailProfile(GMAIL, [{ name: "INBOX", messages: [] }, all])
    expect((await mail(["gm", "sync", "--since-time", "2023-01-01", "--json"])).code).toBe(0)
    const file = takeout([
      { id: synced, subject: "Trip plan", labels: "Inbox,Opened" },
      { id: "1700000000000000002", subject: "Old invoice", labels: "Archived,Opened" },
      { id: "1700000000000000003", subject: "Prize", labels: "Spam" },
    ])

    const first = await mail(["gm", "messages", "import", file, "--json"])
    expect(first.code, first.err).toBe(0)
    expect(first.item).toMatchObject({ address: GMAIL, saved: 1, already_stored: 1, complete: true })
    expect(await emails()).toEqual([synced, "1700000000000000002"])

    const again = await mail(["gm", "messages", "import", file, "--json"])
    expect(again.item).toMatchObject({ saved: 0, complete: true })
  })

  it("stops at --limit and says how many are left", async () => {
    const { mail } = await gmailProfile(GMAIL, [{ name: "INBOX", messages: [] }])
    const file = takeout([
      { id: "1700000000000000004", subject: "First", labels: "Opened" },
      { id: "1700000000000000005", subject: "Second", labels: "Opened" },
    ])

    const first = await mail(["gm", "messages", "import", file, "--since-time", "2020-01-01", "--limit", "1", "--json"])
    expect(first.item).toMatchObject({ saved: 1, complete: false, remaining: 1 })
    expect(first.item.hint).toMatch(/1 new emails are left/)
  })

  it("refuses a profile that is not Gmail, whose ids would store every email twice", async () => {
    const { mail } = await gmailProfile("me@example.com", [{ name: "INBOX", messages: [] }])
    const file = takeout([{ id: "1700000000000000002", subject: "Old invoice", labels: "Opened" }])

    const refused = await mail(["gm", "messages", "import", file, "--json"])
    expect(refused.code).not.toBe(0)
    expect(refused.out + refused.err).toMatch(/not a Gmail mailbox/)
  })
})

describe("account inspect", () => {
  const list = "List-Id: Shop news <news.shop.example>\r\nList-Unsubscribe: <mailto:out@shop.example>\r\n"
  const folders = [
    {
      name: "INBOX",
      messages: [
        { uid: 1, raw: raw("a", "Sale", "Buy", "news@shop.example", list), flags: [], date: OLD },
        { uid: 2, raw: raw("b", "Sale again", "Buy", "deals@shop.example", list), flags: [], date: OLD },
        { uid: 3, raw: raw("c", "Lunch", "Noon?"), flags: ["\\Seen"], date: OLD },
      ],
    },
  ]

  it("groups the server's mail by list and sender, the largest first, and asks no registry by default", async () => {
    const asked: string[] = []
    const { mail } = await harness({ folders })
    const fetch = (async (url: string | URL | Request) => {
      asked.push(String(url))
      if (String(url).endsWith("dns.json"))
        return Response.json({ services: [[["example"], ["https://rdap.registry.example/"]]] })
      return new Response(null, { status: 404 })
    }) as typeof globalThis.fetch

    const answer = await mail(["ya", "account", "inspect", "--json"], { rdap: fetch })
    expect(answer.code, answer.err).toBe(0)
    const { item } = JSON.parse(answer.out)
    expect(item).toMatchObject({ address: ADDRESS, emails: 3, groups: 2 })
    expect(item.items[0]).toMatchObject({ list_id: "news.shop.example", emails: 2, unread: 1, bulk: 1 })
    expect(item.items[1]).toMatchObject({ from: "ann@example.com", list_id: null, emails: 1, unread: 0 })
    expect(asked).toEqual([])

    const text = await mail(
      ["ya", "account", "inspect", "--since-time", "2026-01-01", "--limit", "5", "--folder", "INBOX"],
      { rdap: fetch, tty: true },
    )
    expect(text.out).toMatch(/^3 emails, .* 2 groups;/)
    expect(text.out).toMatch(/emails +MB +unread +bulk +years +replied +suggest +score +sender or list/)
    expect(text.out).toContain("news.shop.example (news@shop.example)")

    const aged = await mail(["ya", "account", "inspect", "--domain-age", "--json"], { rdap: fetch })
    expect(aged.code, aged.err).toBe(0)
    expect(asked).toContain("https://rdap.registry.example/domain/shop.example")
    expect(JSON.parse(aged.out).item.domain_lookups).toEqual({ looked: 1, failed: 0 })
  })
})
