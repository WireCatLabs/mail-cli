import { describe, expect, it } from "vitest"
import { ADDRESS, harness, OLD, raw } from "./testing/mailbox.js"

const inbox = () => [
  {
    name: "INBOX",
    uidValidity: 11,
    messages: [
      { uid: 1, raw: raw("invoice", "Invoice October", "Pay the invoice"), flags: [], date: OLD },
      { uid: 2, raw: raw("lunch", "Lunch friday", "Lunch at noon", "Bob <bob@example.com>"), flags: [], date: OLD },
    ],
  },
]

describe("tags on stored mail", () => {
  it("tags an email in the store only; search tag: finds it, list shows it, remove takes it off", async () => {
    const { mail, json, stored, commands } = await harness({ folders: inbox() })
    const ref = (await json("search", "messages", "invoice")).items[0].ref
    const before = commands().length
    const added = await json("tags", "add", "Bills", "work", "--message", ref)
    expect(added.item).toMatchObject({ target: ref, added: ["bills", "work"], unchanged: [] })
    expect(commands().slice(before)).toEqual([])
    expect((await json("tags", "add", "bills", "--message", ref)).item).toMatchObject({
      added: [],
      unchanged: ["bills"],
    })

    const found = await json("search", "messages", "tag:bills")
    expect(found.items.map((one: { ref: string }) => one.ref)).toEqual([ref])
    const listed = await json("tags", "list", "tag:bills")
    expect(listed.items).toEqual([expect.objectContaining({ tag: "bills", type: "message", target: ref })])
    expect(
      await stored(async (store) => (await store.tags.tags({ provider: "email", account: ADDRESS })).map((t) => t.tag)),
    ).toEqual(expect.arrayContaining(["bills", "work"]))

    expect((await json("tags", "remove", "bills", "--message", ref)).item).toMatchObject({ removed: ["bills"] })
    expect((await json("search", "messages", "tag:bills")).items).toEqual([])
    const missing = await mail(["ya", "tags", "add", "x", "--json"])
    expect(JSON.parse(missing.err).error.code).toBe("validation_error")
  })

  it("tags a conversation, and refuses mail of another mailbox", async () => {
    const { mail, json } = await harness({ folders: inbox() })
    const chat = (await json("conversations", "list")).items.find((one: { title?: string }) =>
      JSON.stringify(one).includes("Lunch"),
    ).ref
    expect((await json("tags", "add", "social", "--chat", chat)).item).toMatchObject({
      target: chat,
      added: ["social"],
    })
    expect((await json("search", "messages", "tag:social")).items).toHaveLength(1)
    expect((await json("tags", "list", "type:chat")).items).toEqual([expect.objectContaining({ target: chat })])
    expect((await json("tags", "add", "lunch", "--chat", chat)).item.added).toEqual(["lunch"])
    const limited = await json("tags", "list", "--limit", "1")
    expect(limited.items).toHaveLength(1)
    expect(limited.has_more ?? limited.meta?.has_more ?? true).toBeTruthy()
    expect((await json("tags", "remove", "social", "--chat", chat)).item).toMatchObject({ removed: ["social"] })
    expect((await json("search", "messages", "tag:social")).items).toEqual([])
    const other = await mail(["ya", "tags", "add", "x", "--message", "msg:email/other%40example.com/t/m", "--json"])
    expect(JSON.parse(other.err).error.code).toBe("not_found")
  })
})
