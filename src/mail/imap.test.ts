import { afterEach, expect, it } from "vitest"
import { type FakeImap, startFakeImap } from "../testing/fake-imap.js"
import { imapSource } from "./imap.js"

const raw = (id: string, subject: string, extra = "") =>
  `Message-ID: <${id}@example.com>\r\nDate: Tue, 27 Oct 2026 10:00:00 +0000\r\nFrom: Ann <ann@example.com>\r\nTo: ya@burobiz.ru\r\nSubject: ${subject}\r\n${extra}\r\n\r\nHello ${subject}\r\n`

let fake: FakeImap | undefined
afterEach(async () => {
  await fake?.close()
  fake = undefined
})

const serve = (throttleBodies = false, dropSearches = 0) =>
  startFakeImap({
    login: "ya@burobiz.ru",
    password: "app-secret-1",
    throttleBodies,
    dropSearches,
    folders: [
      {
        name: "INBOX",
        messages: [
          { uid: 4, raw: raw("a", "first", "List-Id: <news.example.com>\r\n"), flags: ["\\Seen"] },
          { uid: 7, raw: raw("b", "second"), flags: [] },
        ],
      },
      { name: "Sent", attributes: ["\\Sent"], messages: [] },
    ],
  })

const sourceOf = (port: number, password = "app-secret-1") =>
  imapSource({ host: "127.0.0.1", port, security: "plain", login: "ya@burobiz.ru" }, password)

it("logs in and reports capabilities and the folder count", async () => {
  fake = await serve()
  const source = sourceOf(fake.port)
  const checked = await source.check()
  await source.close()
  expect(checked.features).toMatchObject({ idle: true, move: true, uidplus: true, x_gm_ext_1: false })
  expect(checked.folders).toBe(2)
})

it("lists folders with roles and counts", async () => {
  fake = await serve()
  const source = sourceOf(fake.port)
  const folders = await source.folderList()
  await source.close()
  expect(folders).toEqual([
    { path: "INBOX", name: "INBOX", role: "inbox", messages: 2, unseen: 1 },
    { path: "Sent", name: "Sent", role: "sent", messages: 0, unseen: 0 },
  ])
})

it("maps a refused login to authentication_error without the server text or the password", async () => {
  fake = await serve()
  const source = sourceOf(fake.port, "wrong-password-9")
  const failure = await source.check().then(
    () => undefined,
    (error: Error) => error,
  )
  await source.close()
  expect(failure).toMatchObject({ code: "authentication_error" })
  expect(String(failure?.message)).not.toContain("wrong-password-9")
})

it("reads UIDVALIDITY on open, lists envelopes and never asks for a body without PEEK", async () => {
  fake = await serve()
  const source = sourceOf(fake.port)
  const searched = await source.search?.(new Date("2026-10-01"), "INBOX")
  const listed = await source.list(new Date("2026-10-01"), "INBOX", searched ? { searched } : {})
  const raws = await source.fetchRaw(listed)
  await source.close()
  expect(searched).toEqual({ validity: "777", uids: ["4", "7"] })
  expect(listed.map(({ uid, seen, folder }) => ({ uid, seen, folder }))).toEqual([
    { uid: "4", seen: true, folder: "INBOX" },
    { uid: "7", seen: false, folder: "INBOX" },
  ])
  expect(listed[0]?.headers).toMatchObject({
    from: "ann@example.com",
    fromName: "Ann",
    listId: "<news.example.com>",
    bulk: true,
  })
  expect(listed[1]?.headers?.bulk).toBe(false)
  expect(Buffer.from(raws[0] as Uint8Array).toString()).toContain("Hello first")
  const fetches = fake.commands.filter((command) => command.startsWith("UID FETCH"))
  expect(fetches.length).toBeGreaterThan(0)
  for (const fetch of fetches) {
    expect(fetch).not.toMatch(/BODY\[/i)
    expect(fetch).toMatch(/BODY\.PEEK\[/i)
  }
})

it("gives the same ids to the same mail on two runs", async () => {
  fake = await serve()
  const source = sourceOf(fake.port)
  const first = await source.list(new Date("2026-10-01"), "INBOX")
  const second = await source.list(new Date("2026-10-01"), "INBOX")
  await source.close()
  expect(second.map((one) => one.messageId)).toEqual(first.map((one) => one.messageId))
  expect(first[0]?.messageId).toMatch(/^imap:[0-9a-f]{64}$/)
})

it("surfaces a Gmail style NO [THROTTLED] as rate_limited", async () => {
  fake = await serve(true)
  const source = sourceOf(fake.port)
  const listed = await source.list(new Date("2026-10-01"), "INBOX")
  const failure = await source.fetchRaw(listed).then(
    () => undefined,
    (error: Error) => error,
  )
  await source.close()
  expect(failure).toMatchObject({ code: "rate_limited" })
})

it("reconnects once when the connection drops during a read", async () => {
  fake = await serve(false, 1)
  const source = sourceOf(fake.port)
  const found = await source.search?.(new Date("2026-01-01"), "INBOX")
  await source.close()
  expect(found?.uids).toEqual(["4", "7"])
})

it("fails with the raw error code kept when the connection drops twice", async () => {
  fake = await serve(false, 2)
  const source = sourceOf(fake.port)
  const failure = await source.search?.(new Date("2026-01-01"), "INBOX").then(
    () => undefined,
    (error: { code: string; details: { cause_code?: string } }) => error,
  )
  await source.close()
  expect(failure?.code).toBe("network_error")
  expect(failure?.details.cause_code).toMatch(/^[A-Za-z]+/)
})
