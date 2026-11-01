import { describe, expect, it } from "vitest"
import { draftsFolderOf } from "./mail/drafts.js"
import { DEFAULT_ORGANISE, PROVIDERS } from "./providers.js"
import type { FakeFolder } from "./testing/fake-imap.js"
import { ADDRESS, harness, OLD, raw } from "./testing/mailbox.js"

const folders = (drafts: FakeFolder["messages"] = []): FakeFolder[] => [
  {
    name: "INBOX",
    uidValidity: 11,
    messages: [
      {
        uid: 1,
        raw: raw("lunch", "Lunch friday", "Lunch at noon?", "Bob <bob@example.com>", "Cc: Carl <carl@example.com>\r\n"),
        flags: [],
        date: OLD,
      },
    ],
  },
  { name: "Drafts", attributes: ["\\Drafts"], uidValidity: 15, messages: drafts },
  { name: "Trash", attributes: ["\\Trash"], uidValidity: 13, messages: [] },
]

const item = (text: string) => JSON.parse(text).item
const draftsIn = (all: FakeFolder[]) => all[1]?.messages ?? []

describe("the Drafts folder", () => {
  const folder = (path: string, role: string | null = null) => ({ path, name: path, role, messages: 0, unseen: 0 })

  it("is the folder the server marks \\Drafts, else the provider's own name for it", () => {
    expect(draftsFolderOf([folder("INBOX"), folder("Concepts", "drafts")], DEFAULT_ORGANISE)).toBe("Concepts")
    expect(draftsFolderOf([folder("[Gmail]/Drafts")], PROVIDERS.gmail.organise ?? DEFAULT_ORGANISE)).toBe(
      "[Gmail]/Drafts",
    )
    expect(draftsFolderOf([folder("Черновики")], PROVIDERS.yandex.organise ?? DEFAULT_ORGANISE)).toBe("Черновики")
    expect(() => draftsFolderOf([folder("INBOX")], DEFAULT_ORGANISE)).toThrow(/no Drafts folder/)
  })
})

describe("drafts on an IMAP server", () => {
  it("saves a new draft with \\Draft in the Drafts folder, lists it, and sends nothing", async () => {
    const all = folders()
    const { mail, commands } = await harness({ folders: all })
    const created = await mail([
      "ya",
      "drafts",
      "create",
      "--to",
      "Anna <anna@example.com>",
      "--cc",
      "carl@example.com",
      "--bcc",
      "boss@example.com",
      "--subject",
      "Встреча в понедельник",
      "Shall we meet at ten?",
      "--json",
    ])
    expect(created.code, created.err).toBe(0)
    const answer = item(created.out)
    expect(answer).toMatchObject({ action: "create", applied: true, folder: "Drafts", uid: 1 })
    expect(answer.id).toMatch(/@example\.com$/)
    expect(commands().find((line) => line.startsWith("APPEND"))).toContain("(\\Draft \\Seen)")
    const saved = draftsIn(all)[0]?.raw ?? ""
    expect(saved).toContain("Bcc: boss@example.com")
    expect(saved).toContain(`Message-ID: <${answer.id}>`)

    const listed = await mail(["ya", "drafts", "list", "--json"])
    expect(listed.code, listed.err).toBe(0)
    const [draft] = JSON.parse(listed.out).items
    expect(draft).toMatchObject({
      id: answer.id,
      subject: "Встреча в понедельник",
      to: ["Anna <anna@example.com>"],
      bcc: ["boss@example.com"],
      text: "Shall we meet at ten?",
    })
  })

  it("answers a stored message in its thread, to everyone with --reply-all but the owner", async () => {
    const all = folders()
    const { mail, json } = await harness({ folders: all })
    const ref = (await json("search", "messages", "lunch")).items[0].ref
    const created = await mail(["ya", "drafts", "create", "--reply-to", ref, "--reply-all", "Yes, noon.", "--json"])
    expect(created.code, created.err).toBe(0)
    const saved = draftsIn(all)[0]?.raw ?? ""
    expect(saved).toContain("In-Reply-To: <lunch@example.com>")
    expect(saved).toContain("References: <lunch@example.com>")
    expect(saved).toContain("Subject: Re: Lunch friday")
    expect(saved).toMatch(/To: Bob <bob@example\.com>/)
    expect(saved).toMatch(/Cc: Carl <carl@example\.com>/)
    expect(saved).not.toContain(`Cc: ${ADDRESS}`)
  })

  it("updates a draft under the same id: given fields replace, the rest stays, the old version goes", async () => {
    const all = folders()
    const { mail, commands } = await harness({ folders: all })
    const { id } = item(
      (await mail(["ya", "drafts", "create", "--to", "anna@example.com", "--subject", "Plan", "First text", "--json"]))
        .out,
    )
    const updated = await mail(["ya", "drafts", "update", `<${id}>`, "Second text", "--json"])
    expect(updated.code, updated.err).toBe(0)
    expect(item(updated.out)).toMatchObject({ action: "update", applied: true, id, uid: 2, replaced_uid: 1 })
    expect(draftsIn(all)).toHaveLength(1)
    const now = draftsIn(all)[0]?.raw ?? ""
    expect(now).toContain(`Message-ID: <${id}>`)
    expect(now).toContain("Subject: Plan")
    expect(now).toContain("To: anna@example.com")
    expect(now).toContain("Second text")
    expect(commands()).toContain("UID EXPUNGE 1")

    const readdressed = await mail([
      "ya",
      "drafts",
      "update",
      id,
      "--to",
      "boris@example.com",
      "--cc",
      "carl@example.com",
      "--bcc",
      "boss@example.com",
      "--subject",
      "Plan B",
      "--json",
    ])
    expect(readdressed.code, readdressed.err).toBe(0)
    const latest = draftsIn(all)[0]?.raw ?? ""
    expect(latest).toContain("To: boris@example.com")
    expect(latest).toContain("Cc: carl@example.com")
    expect(latest).toContain("Bcc: boss@example.com")
    expect(latest).toContain("Subject: Plan B")
    expect(latest).toContain("Second text")

    const dry = await mail(["ya", "drafts", "update", id, "Third", "--dry-run", "--json"])
    expect(item(dry.out)).toMatchObject({ applied: false })
    expect(draftsIn(all)).toHaveLength(1)
    expect(draftsIn(all)[0]?.raw).toContain("Second text")

    await mail(["ya", "drafts", "create", "--to", "anna@example.com", "Another", "--json"])
    const one = JSON.parse((await mail(["ya", "drafts", "list", "--limit", "1", "--json"])).out)
    expect(one.items).toHaveLength(1)
    expect(one.items[0].text).toBe("Another")
  })

  it("deletes a draft only with --yes, and a dry run changes nothing", async () => {
    const all = folders([
      { uid: 7, raw: raw("old-draft", "Old idea", "Draft text", ADDRESS), flags: ["\\Draft", "\\Seen"], date: OLD },
    ])
    const { mail } = await harness({ folders: all })
    const preview = await mail(["ya", "drafts", "delete", "old-draft@example.com", "--json"])
    expect(preview.code, preview.err).toBe(0)
    expect(item(preview.out)).toMatchObject({ applied: false, uid: 7, subject: "Old idea" })
    const dry = await mail(["ya", "drafts", "delete", "old-draft@example.com", "--yes", "--dry-run", "--json"])
    expect(item(dry.out)).toMatchObject({ applied: false })
    expect(draftsIn(all)).toHaveLength(1)
    const deleted = await mail(["ya", "drafts", "delete", "old-draft@example.com", "--yes", "--json"])
    expect(deleted.code, deleted.err).toBe(0)
    expect(item(deleted.out)).toMatchObject({ action: "delete", applied: true })
    expect(draftsIn(all)).toHaveLength(0)
  })

  it("builds a dry run without storing it, and refuses an address that is not one", async () => {
    const all = folders()
    const { mail } = await harness({ folders: all })
    const dry = await mail(["ya", "drafts", "create", "--to", "anna@example.com", "Hi", "--dry-run", "--json"])
    expect(item(dry.out)).toMatchObject({ applied: false, uid: null })
    expect(draftsIn(all)).toHaveLength(0)
    const wrong = await mail(["ya", "drafts", "create", "--to", "anna at example", "Hi", "--json"])
    expect(JSON.parse(wrong.err).error.code).toBe("validation_error")
    const unknown = await mail(["ya", "drafts", "update", "nope@example.com", "x", "--json"])
    expect(JSON.parse(unknown.err).error.code).toBe("not_found")
  })

  it("is refused under the read-only lock and by a profile that denies drafts", async () => {
    const all = folders()
    const { mail } = await harness({ folders: all })
    const locked = await mail(["ya", "drafts", "create", "--to", "anna@example.com", "Hi", "--json"], {
      env: { MAIL_READ_ONLY: "1" },
    })
    expect(JSON.parse(locked.err).error.code).toBe("permission_error")
    expect((await mail(["ya", "config", "set", "permissions.drafts", "deny", "--json"])).code).toBe(0)
    const denied = await mail(["ya", "drafts", "create", "--to", "anna@example.com", "Hi", "--json"])
    expect(JSON.parse(denied.err).error).toMatchObject({ code: "permission_error" })
    expect(denied.err).toContain("drafts")
    expect(draftsIn(all)).toHaveLength(0)
  })
})
