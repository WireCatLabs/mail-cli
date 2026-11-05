import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { mboxSource } from "./mbox.js"

const first = [
  "X-GM-THRID: 1700000000000000001",
  'X-Gmail-Labels: Inbox,Opened,"Trips, 2019",Starred',
  "From: Alice Example <alice@example.test>",
  "To: owner@example.test",
  "Subject: Plans",
  "",
  "Hello",
  "From the start, a line mbox escaped:",
  "",
  ">From here",
  ">>From deeper",
  "",
].join("\n")
const second = [
  "X-GM-THRID: 1700000000000000001",
  "X-Gmail-Labels: Category Updates,Unread",
  "From: news@shop.example",
  "List-Id: Shop news <news.shop.example>",
  "Subject: Sale",
  "",
  "Buy",
  "",
].join("\r\n")
const spam = ["X-Gmail-Labels: Spam", "From: bob@example.test", "", "x", ""].join("\n")

const mbox = (separators: string[], bodies: string[]) => {
  const path = join(mkdtempSync(join(tmpdir(), "mbox-")), "All mail.mbox")
  const escaped = bodies.map((body) => body.replace(/^(>*From )/gm, ">$1"))
  writeFileSync(path, separators.map((line, index) => `${line}\n${escaped[index]}\n`).join(""))
  return path
}

const SEPARATORS = [
  "From 1700000000000000001@xxx Mon Jul 24 10:00:00 +0000 2023",
  "From 1700000000000000002@xxx Tue Jul 25 10:00:00 +0200 2023",
  "From 1700000000000000003@xxx Wed Jul 26 10:00:00 +0000 2023",
]

describe("mboxSource", () => {
  it("lists Gmail's ids, labels and read state, and gives back each email as stored, across chunk edges", async () => {
    const path = mbox(SEPARATORS, [first, second, spam])

    for (const chunkSize of [7, 64 * 1024]) {
      const source = mboxSource(path, { chunkSize })
      const listed = await source.list(new Date(0), "[Gmail]/All Mail", { headers: true })

      expect(
        listed.map(({ messageId, threadId, receivedAt, labels, seen, flagged }) => ({
          messageId,
          threadId,
          receivedAt,
          labels,
          seen,
          flagged,
        })),
      ).toEqual([
        {
          messageId: "1700000000000000001",
          threadId: "1700000000000000001",
          receivedAt: "2023-07-24T10:00:00.000Z",
          labels: ["Inbox", "Starred", "Trips, 2019"],
          seen: true,
          flagged: true,
        },
        {
          messageId: "1700000000000000002",
          threadId: "1700000000000000001",
          receivedAt: "2023-07-25T08:00:00.000Z",
          labels: ["Category Updates"],
          seen: false,
          flagged: false,
        },
      ])
      expect(listed[1]?.headers).toEqual({
        from: "news@shop.example",
        subject: "Sale",
        to: [],
        listId: "news.shop.example",
        bulk: true,
      })
      const raws = await source.fetchRaw(listed)
      expect(raws.map((raw) => Buffer.from(raw as Uint8Array).toString())).toEqual([first, second])
    }
  })

  it("lists only mail since the time asked", async () => {
    const listed = await mboxSource(mbox(SEPARATORS, [first, second, spam])).list(
      new Date("2023-07-25T00:00:00Z"),
      "[Gmail]/All Mail",
    )

    expect(listed.map(({ messageId }) => messageId)).toEqual(["1700000000000000002"])
  })

  it("reads a separator without a zone as UTC, whatever this computer's zone", async () => {
    const zone = process.env.TZ
    try {
      const times = []
      for (const tz of ["Asia/Vladivostok", "America/Los_Angeles"]) {
        process.env.TZ = tz
        const path = mbox(["From 1700000000000000001@xxx Mon Jul 24 10:00:00 2023"], [first])
        times.push((await mboxSource(path).list(new Date(0), "[Gmail]/All Mail"))[0]?.receivedAt)
      }
      expect(times).toEqual(["2023-07-24T10:00:00.000Z", "2023-07-24T10:00:00.000Z"])
    } finally {
      if (zone === undefined) delete process.env.TZ
      else process.env.TZ = zone
    }
  })

  it("falls back to a Date header with a zone, and refuses one without", async () => {
    const dated = (date: string) => mbox(["From 1700000000000000001@xxx"], [`Date: ${date}\n${first}`])

    const listed = await mboxSource(dated("Mon, 24 Jul 2023 12:00:00 +0200 (CEST)")).list(
      new Date(0),
      "[Gmail]/All Mail",
    )
    expect(listed[0]?.receivedAt).toBe("2023-07-24T10:00:00.000Z")
    await expect(mboxSource(dated("Mon, 24 Jul 2023 12:00:00")).list(new Date(0), "[Gmail]/All Mail")).rejects.toThrow(
      /byte \d+ has no readable date/,
    )
  })

  it("refuses a separator without Gmail's message id instead of inventing one", async () => {
    const path = mbox([SEPARATORS[0] as string, "From MAILER-DAEMON Mon Jul 24 10:00:00 2023"], [first, second])

    await expect(mboxSource(path).list(new Date(0), "[Gmail]/All Mail")).rejects.toThrow(
      /byte \d+ has no Gmail message id/,
    )
  })
})
