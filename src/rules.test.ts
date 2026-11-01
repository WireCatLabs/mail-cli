import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { memoryKeyring } from "@wirecat/cli-base"
import { openStore, storePath } from "@wirecat/cli-core/store"
import { afterEach, describe, expect, it } from "vitest"
import type { MailEnvironment } from "./commands/context.js"
import type { MailEndpoint, RunBounds } from "./mail/backend.js"
import { imapBackend } from "./mail/imap/index.js"
import { importFilters } from "./mail/rules/filters.js"
import { actionsOf, filterMatch } from "./mail/rules/query.js"
import { run } from "./program.js"
import { type FakeImap, startFakeImap } from "./testing/fake-imap.js"

const PASSWORD = "fixture-app-password-7Qp2"
const ADDRESS = "me@example.com"

const raw = (id: string, from: string, subject: string, body: string, extra = "") =>
  `Message-ID: <${id}@example.com>\r\nDate: Tue, 27 Oct 2026 10:00:00 +0000\r\nFrom: ${from}\r\n` +
  `To: ${ADDRESS}\r\nSubject: ${subject}\r\n${extra}\r\n${body}\r\n`

let fake: FakeImap | undefined
afterEach(async () => {
  await fake?.close()
  fake = undefined
})

const harness = async () => {
  fake = await startFakeImap({
    login: ADDRESS,
    password: PASSWORD,
    capabilities: ["CONDSTORE"],
    folders: [
      {
        name: "INBOX",
        messages: [
          { uid: 1, raw: raw("lead1", "Ann <ann@example.com>", "Coffee shop for sale", "A lead about a coffee shop.") },
          {
            uid: 2,
            raw: raw(
              "deal1",
              "Shop Deals <deals@shop.example>",
              "Unrepeatable bargain",
              "Unrepeatable bargain inside",
              "List-Id: <deals.shop.example>\r\n",
            ),
          },
        ],
      },
      { name: "Sent", attributes: ["\\Sent"], messages: [] },
    ],
  })
  const port = fake.port
  const keyring = memoryKeyring()
  const dir = mkdtempSync(join(tmpdir(), "rules-"))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MAIL_CONFIG_DIR: mkdtempSync(join(tmpdir(), "config-")),
    MAIL_STATE_DIR: mkdtempSync(join(tmpdir(), "state-")),
    MESSAGING_STORE: join(mkdtempSync(join(tmpdir(), "store-")), "wirecat.db"),
  }
  delete env.CI
  const mail = async (argv: string[], { password, tty = false }: { password?: string; tty?: boolean } = {}) => {
    const out: string[] = []
    const err: string[] = []
    const options: MailEnvironment & Record<string, unknown> = {
      streams: { data: (text) => out.push(text), diagnostic: (text) => err.push(text) },
      tty,
      env: password === undefined ? env : { ...env, MAIL_PASSWORD: password },
      keyring,
      himalaya: async () => undefined,
      discovery: { mx: async () => ["mx.yandex.net"], fetch: async () => new Response("", { status: 404 }) },
      backend: (endpoint: MailEndpoint, password: string, bounds: RunBounds = {}) =>
        imapBackend({ ...endpoint, host: "127.0.0.1", port, security: "plain" }, password, {
          sleep: async () => {},
          ...bounds,
        }),
    }
    const code = await run(argv, options)
    return { code, out: out.join("\n"), err: err.join("\n") }
  }
  expect((await mail(["ya", "session", "start", "--address", ADDRESS, "--json"], { password: PASSWORD })).code).toBe(0)
  return { mail, env, dir }
}

const body = (text: string) => JSON.parse(text)

const storedEmails = async (env: NodeJS.ProcessEnv) => {
  const store = await openStore({ path: storePath(env), env, command: "mail" })
  try {
    const accountId = await store.accounts.saveAccount({ provider: "email", account: ADDRESS }, { name: ADDRESS })
    return await store.mail.emails({ accountId })
  } finally {
    await store.close()
  }
}

describe("rules", () => {
  it("adds, lists protected ones first, replaces a repeat, and removes a rule", async () => {
    const { mail } = await harness()
    expect(
      (await mail(["ya", "rules", "add", "--domain", "shop.example", "--do", "envelope,tag:promo", "--json"])).code,
    ).toBe(0)
    const kept = await mail(["ya", "rules", "add", "--sender", "Boss@example.com", "--do", "protect", "--json"])
    expect(body(kept.out).item).toMatchObject({ match: { from: "boss@example.com" }, action: "keep", protected: true })
    await mail(["ya", "rules", "add", "--domain", "shop.example", "--do", "envelope", "--reason", "deals", "--json"])

    const listed = body((await mail(["ya", "rules", "list", "--json"])).out).items
    expect(listed).toHaveLength(2)
    expect(listed[0]).toMatchObject({ protected: true })
    expect(listed[1]).toMatchObject({ match: { domain: "shop.example" }, reason: "deals", recorded: { emails: 0 } })
    expect(body((await mail(["ya", "rules", "list", "protected:true", "--json"])).out).items).toHaveLength(1)
    expect((await mail(["ya", "rules", "list"], { tty: true })).out).toMatch(/^PROTECTED {2}from boss@example.com/)

    const removed = await mail(["ya", "rules", "remove", "--domain", "Shop.Example", "--json"])
    expect(body(removed.out).item).toEqual({ removed: { domain: "Shop.Example" } })
    expect(body((await mail(["ya", "rules", "list", "--json"])).out).items).toHaveLength(1)
    const missing = await mail(["ya", "rules", "remove", "--domain", "shop.example", "--json"])
    expect(missing.code).not.toBe(0)
    expect(missing.err + missing.out).toContain("rules list")
  })

  it("removes a rule by each kind of condition it was added with", async () => {
    const { mail } = await harness()
    const conditions = [
      ["--sender", "a@shop.example"],
      ["--list-id", "deals.shop.example"],
      ["--filter", "subject:sale"],
      ["--kind", "newsletters"],
    ]
    for (const condition of conditions)
      expect((await mail(["ya", "rules", "add", ...condition, "--do", "skip", "--json"])).code).toBe(0)
    expect(body((await mail(["ya", "rules", "list", "--json"])).out).items).toHaveLength(4)
    for (const condition of conditions)
      expect((await mail(["ya", "rules", "remove", ...condition, "--json"])).code).toBe(0)
    expect(body((await mail(["ya", "rules", "list", "--json"])).out).items).toEqual([])
  })

  it("refuses a rule with no match condition", async () => {
    const { mail } = await harness()
    const refused = await mail(["ya", "rules", "add", "--do", "skip", "--json"])
    expect(refused.code).not.toBe(0)
    expect(refused.err + refused.out).toContain("give at least one of --sender")
    expect(body((await mail(["ya", "rules", "list", "--json"])).out).items).toEqual([])
  })

  it("exports the rules as a file that imports back into another mailbox's store", async () => {
    const { mail, dir } = await harness()
    await mail(["ya", "rules", "add", "--filter", "from:news older:365d", "--do", "envelope", "--json"])
    await mail(["ya", "rules", "add", "--list-id", "deals.shop.example", "--do", "protect", "--json"])
    const exported = await mail(["ya", "rules", "export"])
    const file = JSON.parse(exported.out)
    expect(file).toMatchObject({ version: 1, account: ADDRESS })
    expect(file.rules).toHaveLength(2)
    expect(file.rules[0].id).toBeUndefined()

    const other = await harness()
    const path = join(dir, "rules.json")
    writeFileSync(path, exported.out)
    const imported = await other.mail(["ya", "rules", "import", path, "--format", "memo", "--json"])
    expect(body(imported.out).items).toHaveLength(2)
    const again = body((await other.mail(["ya", "rules", "list", "--json"])).out).items
    expect(again.map(({ match }: { match: object }) => match)).toEqual(
      expect.arrayContaining([{ from_contains: "news", older_than_days: 365 }, { list_id: "deals.shop.example" }]),
    )

    writeFileSync(path, JSON.stringify({ rules: [{ action: "skip", match: {} }] }))
    const bad = await other.mail(["ya", "rules", "import", path, "--json"])
    expect(bad.code).not.toBe(0)
    expect(bad.err + bad.out).toContain("needs at least one match condition")
  })

  it("previews Gmail filters and adds them only with --yes", async () => {
    const { mail, dir } = await harness()
    const path = join(dir, "Filters.json")
    writeFileSync(
      path,
      JSON.stringify([{ criteria: { from: "news@example.test" }, action: { removeLabelIds: ["INBOX"] } }]),
    )
    const preview = await mail(["ya", "rules", "import", path, "--format", "gmail", "--json"])
    expect(body(preview.out).item).toMatchObject({ added: 0, rules: [{ match: { from: "news@example.test" } }] })
    expect(body((await mail(["ya", "rules", "list", "--json"])).out).items).toEqual([])

    expect(
      body((await mail(["ya", "rules", "import", path, "--format", "gmail", "--yes", "--json"])).out).item,
    ).toMatchObject({ added: 1 })
    expect(body((await mail(["ya", "rules", "list", "--json"])).out).items).toMatchObject([
      { match: { from: "news@example.test" }, action: "envelope", source: "gmail-filter" },
    ])
  })

  it("prints rules, a Gmail filter preview and an apply as text for a person", async () => {
    const { mail, dir } = await harness()
    expect((await mail(["ya", "sync", "--since-time", "2026-10-01", "--json"])).code).toBe(0)
    await mail(["ya", "rules", "add", "--list-id", "deals.shop.example", "--do", "envelope,tag:promo", "--json"])
    await mail(["ya", "rules", "add", "--sender", "boss@example.com", "--do", "protect", "--reason", "boss", "--json"])
    const listed = await mail(["ya", "rules", "list"], { tty: true })
    expect(listed.out).toMatch(/PROTECTED\s+from boss@example\.com/)
    expect(listed.out).toContain("tag promo")
    const applied = await mail(["ya", "rules", "apply"], { tty: true })
    expect(applied.code, applied.err).toBe(0)
    expect(applied.out).toContain("would cut 1 emails to envelopes")
    const path = join(dir, "Filters.json")
    writeFileSync(
      path,
      JSON.stringify([
        { criteria: { to: "me@example.test", subject: "(sale offer)" }, action: { removeLabelIds: ["INBOX"] } },
        { criteria: { hasTheWord: "has:attachment", query: "has:drive" }, action: { removeLabelIds: ["INBOX"] } },
      ]),
    )
    const preview = await mail(["ya", "rules", "import", path, "--format", "gmail"], { tty: true })
    expect(preview.code, preview.err).toBe(0)
    expect(preview.out).toContain("rules proposed")
  })

  it("cuts a stored email an envelope rule matches to its envelope only with --yes", async () => {
    const { mail, env } = await harness()
    expect((await mail(["ya", "sync", "--since-time", "2026-10-01", "--json"])).code).toBe(0)
    await mail(["ya", "rules", "add", "--list-id", "deals.shop.example", "--do", "envelope", "--json"])

    const dry = await mail(["ya", "rules", "apply", "--json"])
    expect(dry.code).toBe(0)
    expect(body(dry.out).item).toMatchObject({ applied: false, listed: 2, envelopes: 1 })
    expect(body(dry.out).next[0]).toMatchObject({ command: "rules apply", args: { yes: true } })
    expect((await storedEmails(env)).find(({ subject }) => subject === "Unrepeatable bargain")?.bodyText).toContain(
      "bargain inside",
    )

    const cut = await mail(["ya", "rules", "apply", "--yes", "--json"])
    expect(body(cut.out).item).toMatchObject({ applied: true, envelopes: 1 })
    const emails = await storedEmails(env)
    const deal = emails.find(({ fromAddress }) => fromAddress === "deals@shop.example")
    expect(deal).toMatchObject({ subject: null, bodyText: null, metadata: { subject: "Unrepeatable bargain" } })
    expect(emails.find(({ fromAddress }) => fromAddress === "ann@example.com")?.bodyText).toContain("coffee shop")
    const listed = body((await mail(["ya", "rules", "list", "--json"])).out).items
    expect(listed[0].recorded.emails).toBe(1)
  })

  it("under the read-only lock refuses a change and still previews with --dry-run", async () => {
    const { mail, env } = await harness()
    await mail(["ya", "sync", "--since-time", "2026-10-01", "--json"])
    await mail(["ya", "rules", "add", "--list-id", "deals.shop.example", "--do", "envelope", "--json"])
    env.MAIL_READ_ONLY = "1"

    expect((await mail(["ya", "rules", "apply", "--yes", "--json"])).code).not.toBe(0)
    const plain = await mail(["ya", "rules", "apply", "--json"])
    expect(plain.code).not.toBe(0)
    expect(plain.err + plain.out).toContain("read-only")
    expect((await mail(["ya", "rules", "add", "--domain", "x.example", "--do", "skip", "--json"])).code).not.toBe(0)
    const preview = await mail(["ya", "rules", "apply", "--yes", "--dry-run", "--json"])
    expect(preview.code).toBe(0)
    expect(body(preview.out).item).toMatchObject({ applied: false, envelopes: 1 })
    expect(
      (await storedEmails(env)).find(({ fromAddress }) => fromAddress === "deals@shop.example")?.bodyText,
    ).toContain("bargain inside")
  })
})

describe("--filter, --do and Gmail filters", () => {
  it("reads every field of a filter query, bare words as subject words", () => {
    expect(
      filterMatch('invoice subject:paid older:365d larger:5MB has:attachment label:"Old receipts" is:unread'),
    ).toEqual({
      subject: "invoice paid",
      older_than_days: 365,
      larger_than_bytes: 5 * 1024 * 1024,
      has_attachments: true,
      label: "Old receipts",
      unread: true,
    })
    expect(filterMatch("from:@shop.example to:me@example.test")).toEqual({
      domain: "shop.example",
      to: "me@example.test",
    })
    expect(() => filterMatch("to:sample")).toThrow(/needs one address/)
    expect(() => filterMatch("list:weekly.example")).toThrow(/not a field/)
  })

  it("reads one action, protection and tags from --do", () => {
    expect(actionsOf("envelope,tag:promo")).toEqual({ action: "envelope", protect: false, tags: ["promo"] })
    expect(actionsOf("protect")).toEqual({ action: "keep", protect: true, tags: [] })
    expect(() => actionsOf("protect,skip")).toThrow(/choose skip, envelope, keep, protect/)
  })

  it("turns hiding filters into envelope rules and skips what a rule cannot mirror", () => {
    const { rules, skipped } = importFilters(
      JSON.stringify({
        filter: [
          { query: "from:news@shop.example from:deals@shop.example", labelsToRemove: ["INBOX"] },
          { query: "to:alice@example.test", labelsToAdd: ["Family"] },
          { query: "list:weekly.example", labelsToRemove: ["INBOX"] },
          { criteria: { from: "a@x.example", negatedQuery: "urgent" }, action: { removeLabelIds: ["INBOX"] } },
        ],
      }),
      "Filters.json",
    )
    expect(rules.map(({ match, action }) => ({ match, action }))).toEqual([
      { match: { from: "news@shop.example" }, action: "envelope" },
      { match: { from: "deals@shop.example" }, action: "envelope" },
      { match: { to: "alice@example.test" }, action: "keep" },
    ])
    expect(skipped.map(({ why }) => why)).toEqual([
      "it uses list:, which this import does not map",
      "it excludes words, which mail rules cannot do",
    ])
  })
})
