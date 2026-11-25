import { describe, expect, it } from "vitest"
import { ADDRESS, harness, raw } from "./testing/mailbox.js"

const ALIAS = "me.alias@example.com"
const OTHER = "other.alias@example.com"

const to = (message: string, address: string) => message.replace(`To: ${ADDRESS}`, `To: ${address}`)

describe("the owner's aliases", () => {
  it("takes Sent mail as the owner's, and mail from and to a configured alias as theirs", async () => {
    const { mail, stored } = await harness({
      folders: [
        {
          name: "INBOX",
          messages: [
            { uid: 1, raw: to(raw("to-alias", "Ping", "For the alias"), ALIAS) },
            { uid: 2, raw: to(raw("from-alias", "Note", "From the alias", `Me <${ALIAS}>`), "pat@example.com") },
          ],
        },
        {
          name: "Sent",
          attributes: ["\\Sent"],
          messages: [{ uid: 1, raw: to(raw("sent-other", "Hello", "Sent", `Me <${OTHER}>`), "pat@example.com") }],
        },
      ],
    })
    const facts = () =>
      stored(async (store, accountId) => {
        const emails = await store.mail.emails({ accountId })
        const threads = await store.mail.threadActivity(accountId, 0)
        return {
          outgoing: Object.fromEntries(emails.map(({ subject, outgoing }) => [subject, outgoing])),
          addressed: Object.fromEntries(threads.map(({ subject, newest }) => [subject, newest?.addressed])),
        }
      })

    expect(await facts()).toMatchObject({
      outgoing: { Ping: false, Note: false, Hello: true },
      addressed: { Ping: false },
    })

    const set = await mail(["ya", "config", "set", "aliases", ALIAS, "--json"])
    expect(set.code, set.err).toBe(0)
    expect((await mail(["ya", "sync", "--since-time", "2026-01-01", "--json"])).code).toBe(0)

    expect(await facts()).toMatchObject({
      outgoing: { Ping: false, Note: true, Hello: true },
      addressed: { Ping: true },
    })
  })

  it("refuses an alias that is not an address", async () => {
    const { mail } = await harness({ folders: [{ name: "INBOX", messages: [] }] })
    const refused = await mail(["ya", "config", "set", "aliases", "not-an-address", "--json"])
    expect(refused.code).not.toBe(0)
  })
})
