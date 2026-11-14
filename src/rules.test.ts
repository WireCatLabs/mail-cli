import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { memoryKeyring } from "@wirecat/cli-base"
import { storedMailRules } from "@wirecat/cli-core/mail"
import { openStore, storePath } from "@wirecat/cli-core/store"
import { afterEach, describe, expect, it } from "vitest"
import type { MailEnvironment } from "./commands/context.js"
import { type MailCredential, type MailEndpoint, passwordCredential, type RunBounds } from "./mail/backend.js"
import { imapBackend } from "./mail/imap/index.js"
import { applyRules } from "./mail/rules/apply.js"
import { rulesFileOf } from "./mail/rules/file.js"
import { importFilters } from "./mail/rules/filters.js"
import { actionsOf, filterMatch } from "./mail/rules/query.js"
import { run } from "./program.js"
import { type FakeImap, startFakeImap } from "./testing/fake-imap.js"
import { answered, mcpClient } from "./testing/mcp.js"

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

const NOTES =
  "Итоги\r\nДоговорились о синтетическом плане.\r\n\r\nЗадачи\r\nЗАДАЧА 1. Пример\r\n\r\n" +
  "Встреча: https://telemost.360.yandex.ru/j/1234567890"

const harness = async (more: { uid: number; raw: string }[] = [], sent: { uid: number; raw: string }[] = []) => {
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
          ...more,
        ],
      },
      { name: "Sent", attributes: ["\\Sent"], messages: sent },
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
  // The time each run had left when it opened the mailbox: its deadline, less the margin kept for answering.
  const timeLeft: (number | undefined)[] = []
  const options = (
    streams: MailEnvironment["streams"],
    { password, tty = false, more = {} }: { password?: string; tty?: boolean; more?: NodeJS.ProcessEnv } = {},
  ): MailEnvironment & Record<string, unknown> => ({
    streams,
    tty,
    env: { ...env, ...more, ...(password === undefined ? {} : { MAIL_PASSWORD: password }) },
    keyring,
    himalaya: async () => undefined,
    discovery: { mx: async () => ["mx.yandex.net"], fetch: async () => new Response("", { status: 404 }) },
    backend: (endpoint: MailEndpoint, password: MailCredential, bounds: RunBounds = {}) => {
      timeLeft.push(bounds.timeLeftMs?.())
      return imapBackend({ ...endpoint, host: "127.0.0.1", port, security: "plain" }, password, {
        sleep: async () => {},
        ...bounds,
      })
    },
  })
  const mail = async (argv: string[], { password, tty = false }: { password?: string; tty?: boolean } = {}) => {
    const out: string[] = []
    const err: string[] = []
    const code = await run(
      argv,
      options(
        { data: (text) => out.push(text), diagnostic: (text) => err.push(text) },
        { tty, ...(password === undefined ? {} : { password }) },
      ),
    )
    return { code, out: out.join("\n"), err: err.join("\n") }
  }
  expect((await mail(["ya", "session", "start", "--address", ADDRESS, "--json"], { password: PASSWORD })).code).toBe(0)
  return { mail, env, dir, options, timeLeft }
}

const body = (text: string) => JSON.parse(text)

const LIST_ID = "List-Id: <deals.shop.example>\r\n"

const storedMeetings = async (env: NodeJS.ProcessEnv) => {
  const store = await openStore({ path: storePath(env), env, command: "mail" })
  try {
    const account = await store.accounts.storedAccount({ provider: "telemost", account: ADDRESS }).catch(() => null)
    return account === null ? [] : await store.meetings.meetings({ accountId: account.id, limit: 10 })
  } finally {
    await store.close()
  }
}

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
    const synced = await mail(["ya", "sync", "--since-time", "2026-10-01", "--json"])
    expect(synced.code, synced.err + synced.out).toBe(0)
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

  it("stops before its time limit with a cursor that goes on through every folder and keeps the counts", async () => {
    const deal = (uid: number, id: string) => ({
      uid,
      raw: raw(id, "Shop Deals <deals@shop.example>", `Bargain ${id}`, `Bargain ${id} inside`, LIST_ID),
    })
    const { mail, env } = await harness([deal(3, "deal3")], [deal(1, "sent-deal")])
    expect((await mail(["ya", "sync", "--since-time", "2026-10-01", "--json"])).code).toBe(0)
    await mail(["ya", "rules", "add", "--list-id", "deals.shop.example", "--do", "envelope", "--json"])
    const stopAfter = async (batches: number, apply: boolean) => {
      const store = await openStore({ path: storePath(env), env, command: "mail" })
      const source = imapBackend(
        { host: "127.0.0.1", port: fake?.port ?? 0, security: "plain", login: ADDRESS },
        passwordCredential(PASSWORD),
        { listSize: 1, connections: 1, sleep: async () => {} },
      )
      let taken = 0
      return applyRules({
        store,
        source,
        account: { address: ADDRESS, rules: await storedMailRules(store, { address: ADDRESS }) },
        folders: ["INBOX", "Sent"],
        since: new Date("2026-10-01"),
        apply,
        take: () => (++taken > batches ? "deadline" : null),
      }).finally(async () => {
        await source.close()
        await store.close()
      })
    }

    // The newest email, the only one in the first batch, is a deal; the rest of INBOX holds one more.
    const preview = await stopAfter(1, false)
    expect(preview).toMatchObject({ stopped: "deadline", listed: 1, envelopes: 1 })
    const previewed = await mail(["ya", "rules", "apply", "--cursor", preview.cursor ?? "", "--json"])
    expect(previewed.code, previewed.err).toBe(0)
    expect(body(previewed.out).item).toMatchObject({ state: "complete", applied: false, listed: 4, envelopes: 3 })
    expect(body(previewed.out).next[0]).toMatchObject({ command: "rules apply", args: { yes: true } })
    expect(body(previewed.out).next[0].args.cursor).toBeUndefined()

    const wrongMode = await mail(["ya", "rules", "apply", "--yes", "--cursor", preview.cursor ?? "", "--json"])
    expect([wrongMode.code, wrongMode.err.includes("without --cursor")]).toEqual([2, true])

    const first = await stopAfter(2, true)
    expect(first).toMatchObject({ stopped: "deadline", listed: 2, envelopes: 2 })
    const rest = await mail(["ya", "rules", "apply", "--yes", "--cursor", first.cursor ?? "", "--json"])
    expect(rest.code, rest.err).toBe(0)
    expect(body(rest.out).item).toMatchObject({ state: "complete", listed: 4, envelopes: 3 })
    expect(body(rest.out).next ?? []).toEqual([])
    const cut = (await storedEmails(env)).filter(({ fromAddress }) => fromAddress === "deals@shop.example")
    expect(cut.map(({ bodyText }) => bodyText)).toEqual([null, null, null])

    const wrong = await mail(["ya", "rules", "apply", "--cursor", "bm90LWEtY3Vyc29y", "--json"])
    expect([wrong.code, wrong.err.includes("--cursor")]).toEqual([2, true])
  })

  it("judges a sender the same whichever batch or part its mail falls in", async () => {
    const note = (uid: number) => ({
      uid,
      raw: raw(`gh${uid}`, "GitHub <notifications@github.com>", `Build ${uid} failed`, `Build ${uid} failed`),
    })
    const wrote = {
      uid: 1,
      raw:
        `Message-ID: <reply1@example.com>\r\nDate: Tue, 27 Oct 2026 11:00:00 +0000\r\nFrom: ${ADDRESS}\r\n` +
        "To: notifications@github.com\r\nSubject: Re: Build\r\n\r\nThanks\r\n",
    }
    const { mail, env } = await harness([note(3), note(4)], [wrote])
    expect((await mail(["ya", "sync", "--since-time", "2026-10-01", "--json"])).code).toBe(0)
    await mail(["ya", "rules", "add", "--kind", "developer", "--do", "envelope", "--json"])
    const dryRun = async (batches: number, cursor?: string) => {
      const store = await openStore({ path: storePath(env), env, command: "mail" })
      const source = imapBackend(
        { host: "127.0.0.1", port: fake?.port ?? 0, security: "plain", login: ADDRESS },
        passwordCredential(PASSWORD),
        { listSize: 1, connections: 1, sleep: async () => {} },
      )
      let taken = 0
      return applyRules({
        store,
        source,
        account: { address: ADDRESS, rules: await storedMailRules(store, { address: ADDRESS }) },
        folders: ["INBOX", "Sent"],
        since: new Date("2026-10-01"),
        apply: false,
        ...(cursor === undefined ? {} : { cursor }),
        take: () => (++taken > batches ? "deadline" : null),
      }).finally(async () => {
        await source.close()
        await store.close()
      })
    }

    // The owner wrote to the sender, and that mail is listed last: no preset may catch the sender before it is read.
    const whole = await dryRun(Number.POSITIVE_INFINITY)
    const part = await dryRun(1)
    expect(part.stopped).toBe("deadline")
    const rest = await dryRun(Number.POSITIVE_INFINITY, part.cursor)
    expect([whole.envelopes, rest.envelopes, rest.listed]).toEqual([0, 0, whole.listed])
  })

  it("counts a sender the owner wrote to before the window as a correspondent", async () => {
    const note = (uid: number) => ({
      uid,
      raw: raw(`gh${uid}`, "GitHub <notifications@github.com>", `Build ${uid} failed`, `Build ${uid} failed`),
    })
    const wrote = {
      uid: 1,
      date: "01-Sep-2026 11:00:00 +0000",
      raw:
        `Message-ID: <reply1@example.com>\r\nDate: Tue, 01 Sep 2026 11:00:00 +0000\r\nFrom: ${ADDRESS}\r\n` +
        "To: notifications@github.com\r\nSubject: Re: Build\r\n\r\nThanks\r\n",
    }
    const { mail } = await harness([note(3)], [wrote])
    expect((await mail(["ya", "sync", "--since-time", "2026-08-01", "--json"])).code).toBe(0)
    await mail(["ya", "rules", "add", "--kind", "developer", "--do", "envelope", "--json"])
    const applied = await mail(["ya", "rules", "apply", "--since-time", "2026-10-01", "--json"])
    expect(applied.code, applied.err).toBe(0)
    expect(body(applied.out).item).toMatchObject({ envelopes: 0 })
  })

  it("runs 15 minutes in a terminal and 45 s over MCP, where a stop answers partial with the step to go on", async () => {
    const { mail, options, timeLeft } = await harness()
    expect((await mail(["ya", "sync", "--since-time", "2026-10-01", "--json"])).code).toBe(0)
    await mail(["ya", "rules", "add", "--list-id", "deals.shop.example", "--do", "envelope", "--json"])
    timeLeft.length = 0
    expect((await mail(["ya", "rules", "apply", "--json"])).code).toBe(0)
    expect(timeLeft[0]).toBeGreaterThan(14 * 60_000)

    // A deadline inside the run's safety margin stops it before its first batch, with no wait.
    const stopped = await mail(["ya", "rules", "apply", "--yes", "--since-time", "2026-10-01", "--timeout", "4s"], {
      tty: true,
    })
    expect(stopped.code, stopped.err).toBe(0)
    expect(stopped.out).toMatch(
      /with a longer one: mail ya rules apply --yes --since-time 2026-10-01 --timeout 30m --cursor \S+/,
    )

    const serve = async (more: NodeJS.ProcessEnv) => {
      const { client, close } = await mcpClient(options({ data: () => {}, diagnostic: () => {} }, { more }), [], "ya")
      try {
        return await answered(
          client.callTool({ name: "mail_write", arguments: { command: "rules apply", arguments: { yes: true } } }),
        )
      } finally {
        expect(await close()).toBe(0)
      }
    }
    timeLeft.length = 0
    expect((await serve({})).isError).not.toBe(true)
    expect(timeLeft[0]).toBeGreaterThan(30_000)
    expect(timeLeft[0]).toBeLessThanOrEqual(45_000)

    const called = await serve({ MAIL_TIMEOUT: "4s" })
    expect(called.isError, JSON.stringify(called.content)).not.toBe(true)
    const text = JSON.stringify(called.content)
    expect(text).toContain('\\"state\\":\\"partial\\"')
    expect(text).toContain('\\"cursor\\"')
  })

  it("never offers a run that read nothing again with the same limit, over MCP or in a terminal, resumed or not", async () => {
    const deal = (uid: number) => ({
      uid,
      raw: raw(`deal${uid}`, "Shop Deals <deals@shop.example>", `Bargain ${uid}`, `Bargain ${uid} inside`, LIST_ID),
    })
    const { mail, env, options } = await harness([deal(3)])
    expect((await mail(["ya", "sync", "--since-time", "2026-10-01", "--json"])).code).toBe(0)
    await mail(["ya", "rules", "add", "--list-id", "deals.shop.example", "--do", "envelope", "--json"])
    const store = await openStore({ path: storePath(env), env, command: "mail" })
    const source = imapBackend(
      { host: "127.0.0.1", port: fake?.port ?? 0, security: "plain", login: ADDRESS },
      passwordCredential(PASSWORD),
      { listSize: 1, connections: 1, sleep: async () => {} },
    )
    let taken = 0
    const first = await applyRules({
      store,
      source,
      account: { address: ADDRESS, rules: await storedMailRules(store, { address: ADDRESS }) },
      folders: ["INBOX", "Sent"],
      since: new Date("2026-10-01"),
      apply: true,
      take: () => (++taken > 1 ? "deadline" : null),
    }).finally(async () => {
      await source.close()
      await store.close()
    })
    expect(first).toMatchObject({ stopped: "deadline", listed: 1 })
    const cursor = first.cursor ?? ""

    const { client, close } = await mcpClient(
      options({ data: () => {}, diagnostic: () => {} }, { more: { MAIL_TIMEOUT: "4s" } }),
      [],
      "ya",
    )
    try {
      for (const args of [{ yes: true }, { yes: true, cursor }]) {
        const called = await client.callTool({
          name: "mail_write",
          arguments: { command: "rules apply", arguments: args },
        })
        const answer = called.structuredContent as { item: { state: string }; next: object[] }
        expect(answer.item.state).toBe("partial")
        expect(answer.next).toEqual([
          {
            kind: "user_action",
            step: "mail.rules-apply-longer-timeout",
            why: expect.stringContaining("MAIL_TIMEOUT"),
            safe_to_auto_execute: false,
          },
        ])
      }
    } finally {
      expect(await close()).toBe(0)
    }

    const terminal = await mail(["ya", "rules", "apply", "--yes", "--cursor", cursor, "--timeout", "4s", "--json"])
    expect(body(terminal.out).next).toMatchObject([
      { command: "rules apply", args: { yes: true, cursor, timeout: "30m" }, safe_to_auto_execute: false },
    ])
  })

  it("over MCP adds Gmail filters with yes and answers rules export with the rules file", async () => {
    const { mail, dir, options } = await harness()
    // Adding a rule decides what an agent may do with mail later, so the owner grants it first.
    expect((await mail(["ya", "config", "set", "permissions.mcp.authority", "allow"])).code).toBe(0)
    const path = join(dir, "Filters.json")
    writeFileSync(
      path,
      JSON.stringify([{ criteria: { from: "news@example.test" }, action: { removeLabelIds: ["INBOX"] } }]),
    )
    const { client, close } = await mcpClient(options({ data: () => {}, diagnostic: () => {} }), [], "ya")
    try {
      const call = async (name: string, command: string, args: object) => {
        const called = await client.callTool({ name, arguments: { command, arguments: args } })
        expect(called.isError, JSON.stringify(called.content)).not.toBe(true)
        return called.structuredContent as { item: Record<string, unknown> }
      }
      const added = await call("mail_write", "rules import", { file: path, format: "gmail", yes: true })
      expect(added.item).toMatchObject({ added: 1 })
      const exported = await call("mail_read", "rules export", {})
      expect(exported.item).toMatchObject({
        version: 1,
        account: ADDRESS,
        rules: [{ match: { from: "news@example.test" }, action: "envelope" }],
      })
    } finally {
      expect(await close()).toBe(0)
    }
  })

  it("saves Telemost's meeting notes as meetings: stored ones with rules apply --yes, new ones on sync", async () => {
    const notes = {
      uid: 3,
      raw: raw("notes1", "Telemost <keeper@telemost.yandex.ru>", "Конспект встречи от 26.10.2026", NOTES),
    }
    const { mail, env } = await harness([notes])
    expect((await mail(["ya", "sync", "--since-time", "2026-10-01", "--json"])).code).toBe(0)

    const added = await mail(["ya", "rules", "add", "--do", "meeting-notes:telemost", "--json"])
    expect(body(added.out).item).toMatchObject({
      match: { from: "keeper@telemost.yandex.ru" },
      action: "keep",
      protected: true,
      meeting_notes: "telemost",
    })
    const dry = await mail(["ya", "rules", "apply", "--json"])
    expect(body(dry.out).item).toMatchObject({ applied: false, meeting_notes: { telemost: { meetings: 1 } } })
    expect(await storedMeetings(env)).toEqual([])

    const applied = await mail(["ya", "rules", "apply", "--yes", "--json"])
    expect(body(applied.out).item).toMatchObject({ applied: true, meeting_notes: { telemost: { meetings: 1 } } })
    expect((await mail(["ya", "sync", "--since-time", "2026-10-01", "--json"])).code).toBe(0)
    const meetings = await storedMeetings(env)
    expect(meetings).toHaveLength(1)
    expect(meetings[0]).toMatchObject({ joinUrl: "https://telemost.360.yandex.ru/j/1234567890" })
    expect((await mail(["ya", "rules", "list"], { tty: true })).out).toContain("telemost meeting notes")
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
    const preview = await mail(["ya", "rules", "apply", "--yes", "--dry-run", "--json"])
    expect(preview.code).toBe(0)
    expect(body(preview.out).item).toMatchObject({ applied: false, envelopes: 1 })
    expect(
      (await storedEmails(env)).find(({ fromAddress }) => fromAddress === "deals@shop.example")?.bodyText,
    ).toContain("bargain inside")
  })
})

describe("rules add under the read-only lock", () => {
  it("adds a sender or list envelope rule as the agent's, and never replaces one or decides more", async () => {
    const { mail, env } = await harness()
    await mail(["ya", "rules", "add", "--sender", "boss@example.com", "--do", "protect", "--json"])
    env.MAIL_READ_ONLY = "1"

    const added = await mail(["ya", "rules", "add", "--sender", "deals@shop.example", "--do", "envelope", "--json"])
    expect(added.code, added.err).toBe(0)
    expect(body(added.out).item).toMatchObject({ match: { from: "deals@shop.example" }, source: "agent" })
    expect((await mail(["ya", "rules", "add", "--list-id", "deals.shop.example", "--do", "envelope"])).code).toBe(0)

    const replace = await mail(["ya", "rules", "add", "--sender", "Boss@example.com", "--do", "envelope", "--json"])
    expect(replace.code).toBe(5)
    expect(replace.err).toContain("replace the rule for from Boss@example.com")
    for (const query of [
      ["--filter", "older:1d"],
      ["--kind", "newsletters"],
      ["--domain", "gmail.com"],
    ]) {
      const refused = await mail(["ya", "rules", "add", ...query, "--do", "envelope", "--json"])
      expect([refused.code, refused.err.includes("give --sender or --list-id")]).toEqual([5, true])
    }
    for (const actions of ["skip", "keep", "protect", "envelope,tag:promo"]) {
      const refused = await mail(["ya", "rules", "add", "--sender", "a@shop.example", "--do", actions, "--json"])
      expect([refused.code, refused.err.includes("more than --do envelope")]).toEqual([5, true])
    }
    for (const argv of [
      ["rules", "remove", "--sender", "boss@example.com"],
      ["rules", "import", "/dev/null"],
      ["rules", "apply", "--yes"],
      ["messages", "delete", "--rules", "--yes"],
      ["messages", "move", "--filter", "from:deals@shop.example", "--folder", "archive", "--yes"],
      ["messages", "send", "--to", "a@example.com", "--subject", "Hi", "Hello", "--yes"],
    ])
      expect((await mail(["ya", ...argv, "--json"])).code).toBe(5)

    delete env.MAIL_READ_ONLY
    const listed = body((await mail(["ya", "rules", "list", "--json"])).out).items
    expect(listed.map((rule: { match: object; source?: string }) => [rule.match, rule.source])).toEqual([
      [{ from: "boss@example.com" }, undefined],
      [{ from: "deals@shop.example" }, "agent"],
      [{ list_id: "deals.shop.example" }, "agent"],
    ])
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
    expect(actionsOf("meeting-notes:telemost")).toEqual({
      action: "keep",
      protect: true,
      tags: [],
      meetingNotes: "telemost",
    })
    expect(() => actionsOf("envelope,meeting-notes:telemost")).toThrow(/goes with keep, protect/)
    expect(() => actionsOf("meeting-notes:zoom")).toThrow(/takes one of telemost/)
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

  it("reads a saved rules file only when each condition has its type", () => {
    const file = (match: unknown) => JSON.stringify({ rules: [{ match, action: "skip" }] })
    expect(rulesFileOf(file({ domain: "shop.example" }), "rules.json", "rules export")).toMatchObject([
      { match: { domain: "shop.example" }, action: "skip" },
    ])
    expect(() => rulesFileOf(file({ older_than_days: "old" }), "rules.json", "rules export")).toThrow(
      /rule 1 has a condition of the wrong type/,
    )
    expect(() => rulesFileOf(file({ colour: "red" }), "rules.json", "rules export")).toThrow(
      /conditions mail does not know: colour/,
    )
    expect(() => rulesFileOf(JSON.stringify(["no"]), "rules.json", "rules export")).toThrow(/no rules list/)
  })
})
