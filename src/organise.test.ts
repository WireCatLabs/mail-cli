import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { memoryKeyring, resolvePaths } from "@wirecat/cli-base"
import { describeProgram } from "@wirecat/cli-base/commands"
import { toolsFromCommands } from "@wirecat/cli-core/mcp"
import { openStore, storePath } from "@wirecat/cli-core/store"
import { afterEach, describe, expect, it } from "vitest"
import type { MailEnvironment } from "./commands/context.js"
import { configuration } from "./config.js"
import type { MailEndpoint, RunBounds } from "./mail/backend.js"
import { imapBackend } from "./mail/imap/index.js"
import { createProgram, run } from "./program.js"
import { type FakeFolder, type FakeImap, type FakeOptions, startFakeImap } from "./testing/fake-imap.js"
import { mcpClient } from "./testing/mcp.js"

const PASSWORD = "fixture-app-password-7Kq2"
const ADDRESS = "me@example.com"

const raw = (id: string, subject: string, body: string, from = "Ann <ann@example.com>") =>
  `Message-ID: <${id}@example.com>\r\nDate: Tue, 01 Sep 2026 10:00:00 +0000\r\nFrom: ${from}\r\n` +
  `To: ${ADDRESS}\r\nSubject: ${subject}\r\n\r\n${body}\r\n`

const OLD = "01-Sep-2026 10:00:00 +0000"

let fake: FakeImap | undefined
afterEach(async () => {
  await fake?.close()
  fake = undefined
})

const yandex = (): FakeFolder[] => [
  {
    name: "INBOX",
    uidValidity: 11,
    messages: [
      { uid: 1, raw: raw("invoice", "Invoice October", "Pay the invoice"), flags: [], date: OLD },
      { uid: 2, raw: raw("lunch", "Lunch friday", "Lunch at noon", "Bob <bob@example.com>"), flags: [], date: OLD },
      { uid: 3, raw: raw("offer", "Big offer", "Buy now", "Shop <news@shop.example>"), flags: ["\\Seen"], date: OLD },
    ],
  },
  { name: "Archive", attributes: ["\\Archive"], uidValidity: 12, messages: [] },
  { name: "Trash", attributes: ["\\Trash"], uidValidity: 13, messages: [] },
  { name: "Sent", attributes: ["\\Sent"], uidValidity: 14, messages: [] },
]

const gmail = (): FakeFolder[] => [
  { name: "INBOX", uidValidity: 21, messages: [] },
  {
    name: "[Gmail]/All Mail",
    attributes: ["\\All"],
    uidValidity: 22,
    messages: [
      {
        uid: 5,
        raw: raw("g-invoice", "Invoice October", "Pay the invoice"),
        flags: [],
        date: OLD,
        emailId: "1001",
        threadId: "2001",
        labels: ["\\Inbox", "Work"],
      },
      {
        uid: 6,
        raw: raw("g-offer", "Big offer", "Buy now", "Shop <news@shop.example>"),
        flags: ["\\Seen"],
        date: OLD,
        emailId: "1002",
        threadId: "2002",
        labels: ["\\Inbox"],
      },
    ],
  },
  { name: "[Gmail]/Trash", attributes: ["\\Trash"], uidValidity: 23, messages: [] },
]

const harness = async (given: Partial<FakeOptions> & { provider?: string } = {}) => {
  const { provider, ...fakeOptions } = given
  fake = await startFakeImap({ login: ADDRESS, password: PASSWORD, folders: yandex(), ...fakeOptions })
  const port = fake.port
  const keyring = memoryKeyring()
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MAIL_CONFIG_DIR: mkdtempSync(join(tmpdir(), "config-")),
    MAIL_STATE_DIR: mkdtempSync(join(tmpdir(), "state-")),
    MEMO_STATE_DIR: mkdtempSync(join(tmpdir(), "memo-state-")),
    MESSAGING_STORE: join(mkdtempSync(join(tmpdir(), "store-")), "wirecat.db"),
  }
  delete env.CI
  const options = (extra: Partial<MailEnvironment> & { password?: string; env?: object } = {}) => {
    const { password, env: more, ...rest } = extra
    return {
      tty: false,
      env: { ...env, ...(password === undefined ? {} : { MAIL_PASSWORD: password }), ...more },
      keyring,
      himalaya: async () => undefined,
      discovery: { mx: async () => ["mx.yandex.net"], fetch: async () => new Response("", { status: 404 }) },
      backend: (endpoint: MailEndpoint, secret: string, bounds: RunBounds = {}) =>
        imapBackend({ ...endpoint, host: "127.0.0.1", port, security: "plain" }, secret, {
          sleep: async () => {},
          ...bounds,
        }),
      ...rest,
    } as MailEnvironment & Record<string, unknown>
  }
  const mail = async (argv: string[], extra: Partial<MailEnvironment> & { password?: string; env?: object } = {}) => {
    const out: string[] = []
    const err: string[] = []
    const code = await run(argv, {
      ...options(extra),
      streams: { data: (text) => out.push(text), diagnostic: (text) => err.push(text) },
    } as MailEnvironment & Record<string, unknown>)
    return { code, out: out.join("\n"), err: err.join("\n") }
  }
  const started = await mail(
    ["ya", "session", "start", "--address", ADDRESS, ...(provider ? ["--provider", provider] : []), "--json"],
    { password: PASSWORD },
  )
  expect(started.code, started.err).toBe(0)
  const synced = await mail(["ya", "sync", "--since-time", "2026-01-01", "--json"])
  expect(synced.code, synced.err).toBe(0)
  // These tests read back what a change left in the store; the server search has tests of its own.
  const json = async (...argv: string[]) => {
    const answer = await mail(["ya", ...argv, ...(argv[0] === "search" ? ["--backend", "archive"] : []), "--json"])
    expect(answer.code, answer.err).toBe(0)
    return JSON.parse(answer.out)
  }
  const refOf = async (word: string): Promise<string> => {
    const found = await json("search", "messages", word)
    expect(found.items, word).toHaveLength(1)
    return found.items[0].ref
  }
  const stored = async <T>(work: (store: Awaited<ReturnType<typeof openStore>>, accountId: number) => Promise<T>) => {
    const store = await openStore({ path: storePath(env), env, command: "mail" })
    try {
      const account = await store.accounts.storedAccount({ provider: "email", account: ADDRESS })
      return await work(store, account?.id as number)
    } finally {
      await store.close()
    }
  }
  return { mail, options, json, refOf, env, stored, commands: () => fake?.commands ?? [] }
}

const item = (text: string) => JSON.parse(text).item

describe("messages mark-read, star and update on an IMAP server", () => {
  it("marks one email read on the server and in the store at once, and a restore takes it back", async () => {
    const folders = yandex()
    const { mail, json, refOf, stored, commands } = await harness({ folders })
    const ref = await refOf("invoice")
    const marked = await mail(["ya", "messages", "mark-read", ref, "--json"])
    expect(marked.code, marked.err).toBe(0)
    const answer = item(marked.out)
    expect(answer).toMatchObject({ action: "mark-read", applied: true, changed: 1, located: 1 })
    expect(commands()).toContain("UID STORE 1 +FLAGS (\\Seen)")
    expect(folders[0]?.messages[0]?.flags).toContain("\\Seen")
    expect(
      await stored(
        async (store, id) =>
          (await store.mail.emails({ accountId: id })).find((one) => one.subject === "Invoice October")?.read,
      ),
    ).toBe(true)
    expect((await json("search", "messages", "is:unread")).items).toHaveLength(1)

    const preview = item((await mail(["ya", "messages", "restore", "--run", answer.run, "--json"])).out)
    expect(preview).toMatchObject({ applied: false, restorable: 1, restored: 0 })
    const dry = item(
      (await mail(["ya", "messages", "restore", "--run", answer.run, "--yes", "--dry-run", "--json"])).out,
    )
    expect(dry).toMatchObject({ applied: false, restored: 0 })
    expect(folders[0]?.messages[0]?.flags).toContain("\\Seen")
    const restored = item((await mail(["ya", "messages", "restore", "--run", answer.run, "--yes", "--json"])).out)
    expect(restored).toMatchObject({ applied: true, restored: 1 })
    expect(folders[0]?.messages[0]?.flags).not.toContain("\\Seen")
    expect((await json("search", "messages", "is:unread")).items).toHaveLength(2)
    const again = item((await mail(["ya", "messages", "restore", "--run", answer.run, "--yes", "--json"])).out)
    expect(again).toMatchObject({ restored: 0 })
  })

  it("stars, and adds and removes keywords; a server that keeps no keywords says so", async () => {
    const folders = yandex()
    const { mail, refOf } = await harness({ folders })
    const ref = await refOf("lunch")
    expect((await mail(["ya", "messages", "star", ref, "--json"])).code).toBe(0)
    expect(
      (await mail(["ya", "messages", "update", ref, "--flag", "answered", "--flag", "$Work", "--json"])).code,
    ).toBe(0)
    expect(folders[0]?.messages[1]?.flags?.sort()).toEqual(["$Work", "\\Answered", "\\Flagged"])
    expect((await mail(["ya", "messages", "update", ref, "--flag", "read", "--replace", "--json"])).code).toBe(0)
    expect(folders[0]?.messages[1]?.flags).toEqual(["\\Seen"])
    const refused = await mail(["ya", "messages", "update", ref, "--flag", "\\Deleted", "--json"])
    expect(refused.code).not.toBe(0)
    expect(refused.err).toContain("Trash")
  })

  it("answers provider_unavailable for a keyword where the folder keeps none", async () => {
    const { mail, refOf } = await harness({ folders: yandex(), noKeywords: true })
    const failed = await mail(["ya", "messages", "update", await refOf("lunch"), "--flag", "$Work", "--json"])
    expect(failed.code).not.toBe(0)
    expect(JSON.parse(failed.err).error.code).toBe("provider_unavailable")
  })

  it("previews a change chosen by --filter and makes it only with --yes", async () => {
    const folders = yandex()
    const { mail, commands } = await harness({ folders })
    const preview = await mail(["ya", "messages", "mark-read", "--filter", "is:unread", "--json"])
    expect(preview.code, preview.err).toBe(0)
    const body = JSON.parse(preview.out)
    expect(body.item).toMatchObject({ applied: false, run: null, located: 2, changed: 0 })
    expect(body.next[0]).toMatchObject({ command: "messages mark-read", args: { filter: "is:unread", yes: true } })
    expect(commands().some((line) => line.startsWith("UID STORE"))).toBe(false)
    const done = item((await mail(["ya", "messages", "mark-read", "--filter", "is:unread", "--yes", "--json"])).out)
    expect(done).toMatchObject({ applied: true, changed: 2 })
  })
})

describe("every message write", () => {
  it("previews by --filter and --limit under --dry-run, even with --yes, and sends nothing", async () => {
    const { mail, commands } = await harness()
    const writes: string[][] = [
      ["mark-read"],
      ["mark-unread"],
      ["star"],
      ["unstar"],
      ["update", "--flag", "answered"],
      ["move", "--folder", "Archive"],
      ["copy", "--folder", "Archive"],
      ["delete"],
    ]
    for (const write of writes) {
      const answer = await mail([
        "ya",
        "messages",
        ...write,
        "--filter",
        "invoice",
        "--limit",
        "1",
        "--dry-run",
        "--yes",
        "--json",
      ])
      expect(answer.code, `${write[0]}: ${answer.err}`).toBe(0)
      expect(item(answer.out)).toMatchObject({ applied: false, selected: 1 })
    }
    expect(commands().some((line) => /^UID (STORE|MOVE|COPY|EXPUNGE)/.test(line))).toBe(false)
  })

  it("marks unread, unstars and removes a keyword, each only where it is set", async () => {
    const folders = yandex()
    const { mail, refOf } = await harness({ folders })
    const ref = await refOf("offer")
    expect(item((await mail(["ya", "messages", "mark-unread", ref, "--json"])).out)).toMatchObject({ changed: 1 })
    expect(item((await mail(["ya", "messages", "mark-unread", ref, "--json"])).out)).toMatchObject({ changed: 0 })
    expect((await mail(["ya", "messages", "star", ref, "--json"])).code).toBe(0)
    expect((await mail(["ya", "messages", "update", ref, "--flag", "$Promo", "--json"])).code).toBe(0)
    expect((await mail(["ya", "messages", "unstar", ref, "--json"])).code).toBe(0)
    expect((await mail(["ya", "messages", "update", ref, "--unflag", "$Promo", "--json"])).code).toBe(0)
    expect(folders[0]?.messages[2]?.flags).toEqual([])
  })
})

describe("what a write refuses before it sends anything", () => {
  it("refuses a bad flag, a bad selection, another mailbox's mail and a move to Trash", async () => {
    const { mail, refOf, commands } = await harness()
    const ref = await refOf("lunch")
    const refusals: [string[], string][] = [
      [["update", ref, "--flag", "no spaces"], "is no flag"],
      [["update", ref], "give --flag or --unflag"],
      [["update", ref, "--flag", "read", "--unflag", "flagged", "--replace"], "--replace takes --flag only"],
      [["mark-read"], "name the messages"],
      [["mark-read", ref, "--filter", "lunch"], "not both"],
      [["mark-read", "chat:email/me%40example.com/t1"], "names no email"],
      [["mark-read", ref.replace("me%40example.com", "other%40example.com")], "not mail of this profile"],
      [["move", ref, "--folder", "trash"], "messages delete"],
      [["delete", ref, "--rules"], "chooses the mail itself"],
      [["delete", ref, "--since-time", "2026-01-01"], "goes with --rules"],
      [["mark-read", "--filter", "lunch", "--limit", "0"], "--limit takes a whole number"],
    ]
    for (const [argv, text] of refusals) {
      const refused = await mail(["ya", "messages", ...argv, "--json"])
      expect(refused.code, argv.join(" ")).not.toBe(0)
      expect(refused.err, argv.join(" ")).toContain(text)
    }
    const unknown = item((await mail(["ya", "messages", "mark-read", `${ref}x`, "--json"])).out)
    expect(unknown).toMatchObject({ applied: false, missing: 1, located: 0 })
    expect((await mail(["ya", "messages", "restore", "--run", "no-such-run", "--json"])).err).toContain("no change run")
    expect((await mail(["ya", "messages", "restore", "--run", "bad id!", "--json"])).code).not.toBe(0)
    expect(commands().some((line) => /^UID (STORE|MOVE|COPY)/.test(line))).toBe(false)
  })

  it("on Gmail refuses a copy to All Mail and a move to a special folder", async () => {
    const { mail, refOf } = await harness({ folders: gmail(), gmail: true, provider: "gmail" })
    const ref = await refOf("invoice")
    expect((await mail(["ya", "messages", "copy", ref, "--folder", "archive", "--json"])).err).toContain("All Mail")
    const archived = item((await mail(["ya", "messages", "move", ref, "--folder", "archive", "--json"])).out)
    expect(archived).toMatchObject({ changed: 1 })
    expect(item((await mail(["ya", "messages", "move", ref, "--folder", "inbox", "--json"])).out)).toMatchObject({
      changed: 1,
    })
  })

  it("counts a cleanup memo already ran on this mailbox, so the first-run cap is spent", async () => {
    const { mail, env } = await harness()
    const dir = join(resolvePaths({ appName: "cli-memo", prefix: "MEMO", env }).state, "mail-trash", "personal")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "old.jsonl"),
      `${JSON.stringify({ type: "run", account: ADDRESS })}\n${JSON.stringify({ type: "batch", moved: ["1"] })}\n`,
    )
    const preview = item((await mail(["ya", "messages", "delete", "--rules", "--json"])).out)
    expect(preview.cleanup).toMatchObject({ first_run: false, limit: 5000 })
  })
})

describe("messages move, copy and delete on an IMAP server", () => {
  it("moves an email, keeps the store's folder and UID in step, and moves it back on restore", async () => {
    const folders = yandex()
    const { mail, json, refOf, stored } = await harness({ folders })
    const ref = await refOf("invoice")
    const moved = item((await mail(["ya", "messages", "move", ref, "--folder", "archive", "--json"])).out)
    expect(moved).toMatchObject({ applied: true, changed: 1, to: "Archive" })
    expect(folders[0]?.messages.map(({ uid }) => uid)).toEqual([2, 3])
    expect(folders[1]?.messages).toHaveLength(1)
    expect((await json("search", "messages", "mailbox:Archive")).items).toHaveLength(1)
    const located = await stored((store, id) => store.mail.folderEmails(id, "Archive", "12"))
    expect(located.map(({ uid }) => uid)).toEqual([1])

    const restored = item((await mail(["ya", "messages", "restore", "--run", moved.run, "--yes", "--json"])).out)
    expect(restored).toMatchObject({ restored: 1 })
    expect(folders[1]?.messages).toHaveLength(0)
    expect(folders[0]?.messages).toHaveLength(3)
    expect((await json("search", "messages", "mailbox:INBOX")).items).toHaveLength(3)
  })

  it("copies an email and takes only the copy away on restore", async () => {
    const folders = yandex()
    const { mail, refOf, commands } = await harness({ folders })
    const copied = item(
      (await mail(["ya", "messages", "copy", await refOf("lunch"), "--folder", "Archive", "--json"])).out,
    )
    expect(copied).toMatchObject({ applied: true, changed: 1 })
    expect(folders[0]?.messages).toHaveLength(3)
    expect(folders[1]?.messages).toHaveLength(1)
    expect((await mail(["ya", "messages", "restore", "--run", copied.run, "--yes", "--json"])).code).toBe(0)
    expect(folders[1]?.messages).toHaveLength(0)
    expect(folders[0]?.messages).toHaveLength(3)
    expect(commands()).toContain("UID EXPUNGE 1")
  })

  it("undoes a copy by the UID the server gave it, and keeps the original that came to the same folder later", async () => {
    const folders = yandex()
    const { mail, refOf, commands } = await harness({ folders })
    const copied = item(
      (await mail(["ya", "messages", "copy", await refOf("lunch"), "--folder", "Archive", "--json"])).out,
    )
    const archive = folders[1] as FakeFolder
    const copy = archive.messages[0] as FakeFolder["messages"][number]
    const inbox = folders[0] as FakeFolder
    const at = inbox.messages.findIndex(({ raw }) => raw === copy.raw)
    const [original] = inbox.messages.splice(at, 1)
    archive.messages.push({ ...(original as FakeFolder["messages"][number]), uid: copy.uid + 1 })

    const restored = await mail(["ya", "messages", "restore", "--run", copied.run, "--yes", "--json"])
    expect(restored.code, restored.err).toBe(0)
    expect(item(restored.out)).toMatchObject({ restored: 1 })
    expect(archive.messages.map(({ uid }) => uid)).toEqual([copy.uid + 1])
    expect(commands()).toContain(`UID EXPUNGE ${copy.uid}`)
    expect(commands()).not.toContain(`UID EXPUNGE ${copy.uid + 1}`)
  })

  it("refuses a folder that does not exist", async () => {
    const { mail, refOf } = await harness()
    const failed = await mail(["ya", "messages", "move", await refOf("lunch"), "--folder", "Nowhere", "--json"])
    expect(JSON.parse(failed.err).error.code).toBe("not_found")
  })

  it("previews a deletion, then moves the email to Trash and out of search, and a restore brings it back", async () => {
    const folders = yandex()
    const { mail, json, refOf } = await harness({ folders })
    const ref = await refOf("offer")
    const preview = item((await mail(["ya", "messages", "delete", ref, "--json"])).out)
    expect(preview).toMatchObject({ applied: false, located: 1, to: "Trash" })
    expect(folders[2]?.messages).toHaveLength(0)

    const deleting = await mail(["ya", "messages", "delete", ref, "--yes", "--json"])
    expect(deleting.code, deleting.err).toBe(0)
    const deleted = item(deleting.out)
    expect(deleted).toMatchObject({ applied: true, changed: 1 })
    expect(folders[2]?.messages).toHaveLength(1)
    expect((await json("search", "messages", "offer")).items).toHaveLength(0)
    const twice = item((await mail(["ya", "messages", "delete", ref, "--yes", "--json"])).out)
    expect(twice).toMatchObject({ changed: 0, already_deleted: 1 })

    const restored = item((await mail(["ya", "messages", "restore", "--run", deleted.run, "--yes", "--json"])).out)
    expect(restored).toMatchObject({ restored: 1 })
    expect(folders[2]?.messages).toHaveLength(0)
    expect(folders[0]?.messages.map(({ uid }) => uid)).toEqual([1, 2, 4])
    expect((await mail(["ya", "sync", "--since-time", "2026-01-01", "--json"])).code).toBe(0)
    expect((await json("search", "messages", "offer")).items).toHaveLength(1)
  })
})

describe("the write guard", () => {
  it("refuses every write under the read-only lock and sends nothing", async () => {
    const { mail, refOf, commands } = await harness()
    const ref = await refOf("lunch")
    const refused = await mail(["ya", "messages", "mark-read", ref, "--json"], { env: { MAIL_READ_ONLY: "1" } })
    expect(refused.code).not.toBe(0)
    expect(JSON.parse(refused.err).error.code).toBe("permission_error")
    expect(commands().some((line) => line.startsWith("UID STORE"))).toBe(false)
  })

  it("follows the profile's levels: deny refuses, ask needs --yes without a terminal, and the journal keeps no content", async () => {
    const { mail, refOf, env, commands } = await harness()
    const ref = await refOf("lunch")
    expect((await mail(["ya", "config", "set", "permissions.messages.move", "deny", "--json"])).code).toBe(0)
    const denied = await mail(["ya", "messages", "move", ref, "--folder", "Archive", "--json"])
    expect(JSON.parse(denied.err).error.code).toBe("permission_error")
    expect((await mail(["ya", "config", "set", "permissions.messages.move", "ask", "--json"])).code).toBe(0)
    const asked = await mail(["ya", "messages", "move", ref, "--folder", "Archive", "--json"])
    expect(JSON.parse(asked.err).error.code).toBe("confirmation_required")
    expect(commands().some((line) => line.startsWith("UID MOVE"))).toBe(false)
    expect((await mail(["ya", "messages", "move", ref, "--folder", "Archive", "--yes", "--json"])).code).toBe(0)

    const state = resolvePaths({ appName: "mail-cli", prefix: "MAIL", env }).state
    const journals = readdirSync(state, { recursive: true })
      .map(String)
      .filter((name) => name.includes("sends") && statSync(join(state, name)).isFile())
    const text = journals.map((name) => readFileSync(join(state, name), "utf8")).join("\n")
    expect(text).toContain("message-move")
    expect(text).not.toContain("Lunch")
    expect(text).not.toContain("bob@example.com")
  })
})

describe("an agent over MCP", () => {
  it("sees yes and dry_run on a deletion, gets a preview without yes, and deletes with it", async () => {
    const tools = toolsFromCommands(describeProgram(createProgram()), { permissions: configuration.permissions })
    const remove = tools.find((tool) => tool.command === "messages delete")
    expect(Object.keys(remove?.input.entries ?? {})).toEqual(
      expect.arrayContaining(["yes", "dry_run", "filter", "message"]),
    )

    const folders = yandex()
    const { mail, refOf } = await harness({ folders })
    const ref = await refOf("offer")
    const asAgent = async (argv: string[]) => {
      let answer: unknown
      let failed: unknown
      const agent = { result: (value: unknown) => (answer = value), failure: (error: unknown) => (failed = error) }
      await mail(argv, { agent } as Partial<MailEnvironment>)
      if (failed) throw new Error(JSON.stringify(failed))
      return (answer as { item: Record<string, unknown> }).item
    }
    expect(await asAgent(["ya", "messages", "delete", ref, "--json"])).toMatchObject({ applied: false })
    expect(folders[2]?.messages).toHaveLength(0)
    expect(await asAgent(["ya", "messages", "delete", ref, "--yes", "--json"])).toMatchObject({ applied: true })
    expect(folders[2]?.messages).toHaveLength(1)
  })
})

describe("Gmail: labels, Trash and memo's runs", () => {
  it("moves by labels on All Mail and restores them", async () => {
    const folders = gmail()
    const { mail, json, refOf } = await harness({ folders, gmail: true, provider: "gmail" })
    const ref = await refOf("invoice")
    const moved = item((await mail(["ya", "messages", "move", ref, "--folder", "Receipts", "--json"])).out)
    expect(moved).toMatchObject({ applied: true, changed: 1, to: "Receipts" })
    expect(folders[1]?.messages[0]?.labels?.sort()).toEqual(["Receipts", "Work"])
    expect((await json("search", "messages", "label:Receipts")).items).toHaveLength(1)
    expect((await json("search", "messages", "label:Inbox invoice")).items).toHaveLength(0)
    expect((await mail(["ya", "messages", "restore", "--run", moved.run, "--yes", "--json"])).code).toBe(0)
    expect(folders[1]?.messages[0]?.labels?.sort()).toEqual(["Work", "\\Inbox"])
    expect((await json("search", "messages", "label:Inbox invoice")).items).toHaveLength(1)
  })

  it("deletes to Trash and restores to the Inbox with the labels the email had", async () => {
    const folders = gmail()
    const { mail, refOf } = await harness({ folders, gmail: true, provider: "gmail" })
    const deleted = item((await mail(["ya", "messages", "delete", await refOf("invoice"), "--yes", "--json"])).out)
    expect(deleted).toMatchObject({ applied: true, changed: 1, to: "[Gmail]/Trash" })
    expect(folders[1]?.messages).toHaveLength(1)
    expect(folders[2]?.messages).toHaveLength(1)
    const restored = item((await mail(["ya", "messages", "restore", "--run", deleted.run, "--yes", "--json"])).out)
    expect(restored).toMatchObject({ restored: 1, expired: false })
    expect(folders[2]?.messages).toHaveLength(0)
    const back = folders[1]?.messages.find(({ emailId }) => emailId === "1001")
    expect(back?.labels?.sort()).toEqual(["Work", "\\Inbox"])
  })

  it("restores a cleanup run memo made, by its id", async () => {
    const folders = gmail()
    const trashed = folders[1]?.messages.splice(1, 1)[0]
    folders[2]?.messages.push({ ...(trashed as FakeFolder["messages"][number]), uid: 1, labels: [] })
    const { mail, env } = await harness({ folders, gmail: true, provider: "gmail" })
    const id = "2026-10-20T10-00-00-000Z-ab12"
    const dir = join(resolvePaths({ appName: "cli-memo", prefix: "MEMO", env }).state, "mail-trash", "personal")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `${id}.jsonl`),
      [
        { type: "run", id, account: ADDRESS, started_at: new Date(Date.now() - 86_400_000).toISOString(), limit: 100 },
        {
          type: "email",
          batch: 1,
          message_id: "1002",
          labels: ["Inbox", "Promo"],
          flagged: false,
          rule: "domain:shop",
        },
        { type: "batch", batch: 1, moved: ["1002"], not_moved: [] },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"),
    )
    const restored = item((await mail(["ya", "messages", "restore", "--run", id, "--yes", "--json"])).out)
    expect(restored).toMatchObject({ command: "memo mail delete", restored: 1 })
    const back = folders[1]?.messages.find(({ emailId }) => emailId === "1002")
    expect(back?.labels?.sort()).toEqual(["Promo", "\\Inbox"])
    const again = item((await mail(["ya", "messages", "restore", "--run", id, "--json"])).out)
    expect(again).toMatchObject({ logged: 1, restorable: 0, missing: 0 })
  })
})

describe("messages delete --rules", () => {
  it("moves only the envelopes the rules let go, after a fresh backup, and a first run at most 100", async () => {
    const folders = yandex()
    const { mail, env, stored } = await harness({ folders })
    await stored(async (store, id) => {
      await store.mail.rules.upsert(
        id,
        {
          conditions: { domain: "shop.example" },
          actions: { store: "envelope" },
          source: "owner",
          decidedAt: Date.now(),
        },
        Date.now(),
      )
    })
    // The envelope rule applies to mail the next listing reads, so the shop's offer is read again as an envelope.
    expect((await mail(["ya", "rules", "apply", "--since-time", "2026-01-01", "--yes", "--json"])).code).toBe(0)
    const preview = item((await mail(["ya", "messages", "delete", "--rules", "--json"])).out)
    expect(preview).toMatchObject({
      applied: false,
      located: 1,
      cleanup: { envelopes: 1, first_run: true, limit: 100 },
    })
    const refused = await mail(["ya", "messages", "delete", "--rules", "--yes", "--json"])
    expect(JSON.parse(refused.err).error.reason, refused.err).toBe("mail.archive-unverified")
    const marker = join(dirname(storePath(env)), "backups", "last.json")
    mkdirSync(dirname(marker), { recursive: true })
    writeFileSync(marker, JSON.stringify({ at: new Date().toISOString() }))
    const timed = await mail(["ya", "messages", "delete", "--rules", "--yes", "--json"], {
      env: { MAIL_SCHEDULED: "cleanup" },
    })
    expect(JSON.parse(timed.err).error).toMatchObject({ code: "permission_error", reason: "mail.cleanup-scheduled" })
    expect(folders[2]?.messages).toHaveLength(0)
    const done = item((await mail(["ya", "messages", "delete", "--rules", "--yes", "--json"])).out)
    expect(done).toMatchObject({ applied: true, changed: 1 })
    expect(folders[2]?.messages).toHaveLength(1)
    const again = item((await mail(["ya", "messages", "delete", "--rules", "--json"])).out)
    expect(again.cleanup).toMatchObject({ first_run: false, envelopes: 0 })
    const recent = item(
      (await mail(["ya", "messages", "delete", "--rules", "--since-time", "2026-10-01", "--json"])).out,
    )
    expect(recent).toMatchObject({ applied: false, located: 0 })
  })
})

describe("folders create, rename and delete", () => {
  it("makes, renames and deletes an empty folder, and refuses one that holds mail", async () => {
    const folders = yandex()
    const { mail, commands } = await harness({ folders })
    expect(item((await mail(["ya", "folders", "create", "Receipts", "--json"])).out)).toMatchObject({
      action: "create",
    })
    expect((await mail(["ya", "folders", "rename", "Receipts", "Invoices", "--json"])).code).toBe(0)
    expect(folders.map(({ name }) => name)).toContain("Invoices")
    const special = await mail(["ya", "folders", "delete", "INBOX", "--yes", "--json"])
    expect(special.code).not.toBe(0)
    const preview = await mail(["ya", "folders", "delete", "Invoices", "--json"])
    expect(item(preview.out)).toMatchObject({ action: "delete", applied: false, folder: "Invoices", messages: 0 })
    expect(folders.map(({ name }) => name)).toContain("Invoices")
    expect((await mail(["ya", "folders", "delete", "Invoices", "--yes", "--json"])).code).toBe(0)
    expect(folders.map(({ name }) => name)).not.toContain("Invoices")
    expect((await mail(["ya", "folders", "create", "Old", "--json"])).code).toBe(0)
    folders.find(({ name }) => name === "Old")?.messages.push({ uid: 1, raw: raw("kept", "Kept", "Kept"), flags: [] })
    const full = await mail(["ya", "folders", "delete", "Old", "--yes", "--json"])
    expect(JSON.parse(full.err).error.reason).toBe("mail.folder-not-empty")
    const dangerous = await mail(["ya", "folders", "delete", "Old", "--yes", "--allow-dangerous", "--json"])
    expect(dangerous.code, dangerous.err).toBe(0)
    expect(item(dangerous.out)).toMatchObject({ action: "delete", applied: true, messages: 1 })
    expect(commands().filter((line) => /^(CREATE|RENAME|DELETE) /.test(line))).toEqual([
      "CREATE Receipts",
      "RENAME Receipts Invoices",
      "DELETE Invoices",
      "CREATE Old",
      "DELETE Old",
    ])
  })

  it("takes a folder whose message count the server does not give for one that holds mail", async () => {
    const folders = [...yandex(), { name: "Unknown", uidValidity: 31, messages: [] }]
    const { mail, commands } = await harness({ folders, uncounted: ["Unknown"] })
    const refused = await mail(["ya", "folders", "delete", "Unknown", "--yes", "--json"])
    expect(JSON.parse(refused.err).error).toMatchObject({
      reason: "mail.folder-not-empty",
      message: expect.stringContaining("an unknown number of"),
    })
    expect(commands().some((line) => line.startsWith("DELETE "))).toBe(false)
  })

  it("never offers an agent --allow-dangerous, so over MCP only an empty folder goes, and only with yes", async () => {
    const tools = toolsFromCommands(describeProgram(createProgram()), { permissions: configuration.permissions })
    const remove = tools.find((tool) => tool.command === "folders delete")
    expect(Object.keys(remove?.input.entries ?? {})).toEqual(expect.arrayContaining(["folder", "yes", "dry_run"]))
    expect(remove?.input.entries).not.toHaveProperty("allow_dangerous")

    const folders = yandex()
    folders.push(
      { name: "Old", uidValidity: 32, messages: [{ uid: 1, raw: raw("kept", "Kept", "Kept"), flags: [] }] },
      { name: "Empty", uidValidity: 33, messages: [] },
    )
    const { options } = await harness({ folders })
    const { client, close } = await mcpClient(options() as Parameters<typeof mcpClient>[0], [], "ya")
    try {
      const call = (args: Record<string, unknown>) =>
        client.callTool({ name: "mail_write", arguments: { command: "folders delete", arguments: args } }) as Promise<{
          isError?: boolean
          content?: { text?: string }[]
        }>
      const preview = await call({ folder: "Empty" })
      expect(JSON.stringify(preview.content)).toContain("a preview")
      expect(folders.map(({ name }) => name)).toContain("Empty")
      const full = await call({ folder: "Old", yes: true })
      expect(full.isError).toBe(true)
      expect(JSON.stringify(full.content)).toContain("mail.folder-not-empty")
      const forced = await call({ folder: "Old", yes: true, allow_dangerous: true })
      expect(forced.isError).toBe(true)
      expect(folders.map(({ name }) => name)).toContain("Old")
      expect((await call({ folder: "Empty", yes: true })).isError).not.toBe(true)
      expect(folders.map(({ name }) => name)).not.toContain("Empty")
    } finally {
      expect(await close()).toBe(0)
    }
  })
})
