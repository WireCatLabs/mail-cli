import type { Quick, Searched } from "@wirecat/cli-core/mail"
import { ImapFlow } from "imapflow"
import { afterEach, expect, it, vi } from "vitest"
import { type FakeImap, type FakeMessage, type FakeOptions, startFakeImap } from "../testing/fake-imap.js"
import { type ImapTuning, imapSource, mapImapError } from "./imap.js"

const raw = (id: string, subject: string, extra = "") =>
  `Message-ID: <${id}@example.com>\r\nDate: Tue, 27 Oct 2026 10:00:00 +0000\r\nFrom: Ann <ann@example.com>\r\nTo: ya@burobiz.ru\r\nSubject: ${subject}\r\n${extra}\r\n\r\nHello ${subject}\r\n`

let fake: FakeImap | undefined
afterEach(async () => {
  vi.restoreAllMocks()
  await fake?.close()
  fake = undefined
})

const serve = (throttleBodies = false, dropSearches = 0, extra: Partial<FakeOptions> = {}) =>
  startFakeImap({
    login: "ya@burobiz.ru",
    password: "app-secret-1",
    throttleBodies,
    dropSearches,
    ...extra,
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

const sourceOf = (port: number, password = "app-secret-1", tuning: ImapTuning = {}) =>
  imapSource({ host: "127.0.0.1", port, security: "plain", login: "ya@burobiz.ru" }, password, {
    sleep: async () => {},
    ...tuning,
  })

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
  expect(searched).toEqual({ validity: "777", uids: ["4", "7"], quick: true })
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

const SINCE = new Date("2026-10-01")
const failureOf = <T>(work: Promise<T>) =>
  work.then(
    () => undefined,
    (error: { code: string; details: { cause_code?: string; reason?: string } }) => error,
  )

it("reconnects with a growing, jittered wait when the connection drops during a read", async () => {
  fake = await serve(false, 2)
  const waits: number[] = []
  const source = sourceOf(fake.port, undefined, { sleep: async (ms) => void waits.push(ms), random: () => 0.5 })
  const found = await source.search?.(SINCE, "INBOX")
  await source.close()
  expect(found?.uids).toEqual(["4", "7"])
  expect(waits).toEqual([1000, 3000])
})

it("fails with the raw error code kept when the attempts run out", async () => {
  fake = await serve(false, 10)
  const source = sourceOf(fake.port, undefined, { maxAttempts: 3 })
  const failure = await failureOf(source.search?.(SINCE, "INBOX") as Promise<unknown>)
  await source.close()
  expect(failure?.code).toBe("network_error")
  expect(failure?.details.cause_code).toMatch(/^[A-Za-z]+/)
})

it("makes no retry the run's budget or deadline does not allow", async () => {
  fake = await serve(false, 10)
  const noBudget = sourceOf(fake.port, undefined, { canRetry: () => false })
  expect((await failureOf(noBudget.search?.(SINCE, "INBOX") as Promise<unknown>))?.code).toBe("network_error")
  await noBudget.close()
  const waits: number[] = []
  const late = sourceOf(fake.port, undefined, { timeLeftMs: () => 500, sleep: async (ms) => void waits.push(ms) })
  expect((await failureOf(late.search?.(SINCE, "INBOX") as Promise<unknown>))?.code).toBe("network_error")
  await late.close()
  expect(waits).toEqual([])
})

it("goes on after the server closes the connection in the middle of a FETCH", async () => {
  fake = await serve(false, 0, { dropFetches: 1 })
  const source = sourceOf(fake.port)
  const searched = await source.search?.(SINCE, "INBOX")
  const listed = await source.list(SINCE, "INBOX", searched ? { searched } : {})
  await source.close()
  expect(listed.map(({ uid }) => uid)).toEqual(["4", "7"])
})

it("stops when a reconnect finds another UIDVALIDITY, and does not retry that", async () => {
  fake = await serve(false, 0, { dropFetches: 1, validityAfterDrop: 5 })
  const source = sourceOf(fake.port)
  const searched = await source.search?.(SINCE, "INBOX")
  const failure = await failureOf(source.list(SINCE, "INBOX", searched ? { searched } : {}))
  await source.close()
  expect(failure).toMatchObject({ code: "invalid_response", details: { reason: "mail.uidvalidity-changed" } })
})

it("leaves out a message the server answers with NO [UNAVAILABLE] and reads the rest", async () => {
  fake = await serve(false, 0, { unavailableOnce: [4] })
  const source = sourceOf(fake.port)
  const searched = await source.search?.(SINCE, "INBOX")
  const first = await source.list(SINCE, "INBOX", searched ? { searched } : {})
  const again = await source.list(SINCE, "INBOX", searched ? { searched } : {})
  await source.close()
  expect(first.map(({ uid }) => uid)).toEqual(["7"])
  expect(again.map(({ uid }) => uid)).toEqual(["4", "7"])
})

it("answers an Error, not a failed call, for a body the server did not return", async () => {
  fake = await serve(false, 0, { unavailableOnce: [7] })
  const source = sourceOf(fake.port)
  const listed = ["4", "7"].map((uid) => ({
    uid,
    messageId: uid,
    threadId: uid,
    receivedAt: "2026-10-27T10:00:00.000Z",
    folder: "INBOX",
  }))
  const raws = await source.fetchRaw(listed)
  await source.close()
  expect(raws[0]).toBeInstanceOf(Uint8Array)
  expect(raws[1]).toMatchObject({ code: "not_found", details: { reason: "mail.not-returned" } })
})

it("loses only the message Yandex can never read when it refuses the whole batch", async () => {
  fake = await serve(false, 0, { brokenBodies: [4] })
  const waits: number[] = []
  const source = sourceOf(fake.port, undefined, { sleep: async (ms) => void waits.push(ms) })
  const listed = ["4", "7"].map((uid) => ({
    uid,
    messageId: uid,
    threadId: uid,
    receivedAt: "2026-10-27T10:00:00.000Z",
    folder: "INBOX",
  }))
  const raws = await source.fetchRaw(listed)
  await source.close()
  expect(raws[0]).toMatchObject({ code: "provider_unavailable", details: { cause_code: "UNAVAILABLE" } })
  expect(raws[1]).toBeInstanceOf(Uint8Array)
})

it("lists the rest of a batch whose headers Yandex refuses for one message it can never read", async () => {
  fake = await serve(false, 0, { brokenHeaders: [4] })
  const source = sourceOf(fake.port)
  const listed = await source.list(SINCE, "INBOX")
  await source.close()
  expect(listed.map(({ uid }) => uid)).toEqual(["7"])
})

it("times a command out on its own and reports the transport code", async () => {
  fake = await serve(false, 0, { fetchDelayMs: 600 })
  const source = sourceOf(fake.port, undefined, { requestTimeoutMs: 200, maxAttempts: 2 })
  const searched = await source.search?.(SINCE, "INBOX")
  const failure = await failureOf(source.list(SINCE, "INBOX", searched ? { searched } : {}))
  await source.close()
  expect(failure).toMatchObject({ code: "timeout", details: { cause_code: "RequestTimeout" } })
})

it("spreads a call over its connections and keeps the order", async () => {
  fake = await serve()
  const source = sourceOf(fake.port, undefined, { listSize: 1, fetchSize: 1, connections: 2 })
  expect(source.listBatch).toBe(2)
  const listed = await source.list(SINCE, "INBOX")
  const raws = await source.fetchRaw(listed)
  await source.close()
  expect(listed.map(({ uid }) => uid)).toEqual(["4", "7"])
  expect(
    raws.map((raw) =>
      Buffer.from(raw as Uint8Array)
        .toString()
        .includes("Hello"),
    ),
  ).toEqual([true, true])
  expect(fake.commands.filter((command) => command.startsWith("UID FETCH 4"))).not.toHaveLength(0)
  expect(fake.commands.filter((command) => command.startsWith("UID FETCH 7"))).not.toHaveLength(0)
})

it("treats a connection the server closes right after it opened as a dropped line, with its code kept", () => {
  for (const code of ["ClosedAfterConnectTLS", "ClosedAfterConnectText", "EConnectionClosed", "NoConnection"])
    expect(mapImapError({ code, message: "Unexpected close" })).toMatchObject({
      code: "network_error",
      details: { cause_code: code, retryable: true },
    })
})

it("keeps the code of every failure it maps, and retries the ones that are momentary", () => {
  expect(mapImapError({ code: "LockTimeout" })).toMatchObject({
    code: "timeout",
    details: { cause_code: "LockTimeout" },
  })
  expect(mapImapError({ code: "InvalidResponse" })).toMatchObject({
    code: "network_error",
    details: { cause_code: "InvalidResponse" },
  })
  expect(mapImapError({ responseStatus: "NO", serverResponseCode: "UNAVAILABLE" })).toMatchObject({
    code: "provider_unavailable",
    details: { retryable: true, cause_code: "UNAVAILABLE" },
  })
  expect(
    mapImapError({ responseStatus: "NO", responseText: "Mailbox quota exceeded for Ann <ann@example.com>" }),
  ).toMatchObject({
    code: "provider_error",
    details: { cause_code: "NO" },
  })
})

it("retries a command the server refused with a tagged NO [UNAVAILABLE]", async () => {
  fake = await serve(false, 0, { refuseFetches: 2 })
  const waits: number[] = []
  const source = sourceOf(fake.port, undefined, { sleep: async (ms) => void waits.push(ms) })
  const listed = await source.list(SINCE, "INBOX")
  await source.close()
  expect(listed.map(({ uid }) => uid)).toEqual(["4", "7"])
  expect(waits).toHaveLength(2)
})

it("reconnects and selects the folder again when a command finds no mailbox selected", async () => {
  fake = await serve()
  const fetchAll = ImapFlow.prototype.fetchAll
  let failed = false
  vi.spyOn(ImapFlow.prototype, "fetchAll").mockImplementation(function (this: ImapFlow, ...args) {
    if (failed) return fetchAll.apply(this, args)
    failed = true
    return Promise.reject(Object.assign(new Error("No mailbox is selected"), { code: "NoMailboxSelected" }))
  })
  const waits: number[] = []
  const source = sourceOf(fake.port, undefined, { sleep: async (ms) => void waits.push(ms) })
  const listed = await source.list(SINCE, "INBOX")
  await source.close()
  expect(listed.map(({ uid }) => uid)).toEqual(["4", "7"])
  expect(waits).toHaveLength(1)
  const lines = fake.commands
    .filter((command) => /^(EXAMINE|SELECT|UID FETCH)/.test(command))
    .map((c) => c.split(" ")[0])
  expect(lines).toEqual(["EXAMINE", "EXAMINE", "UID"])
})

it("maps NoMailboxSelected to a retryable network error with its code kept", () => {
  expect(mapImapError({ code: "NoMailboxSelected" })).toMatchObject({
    code: "network_error",
    details: { cause_code: "NoMailboxSelected", retryable: true },
  })
})

const FROM = new Date("2026-10-01")

it("lists a server with no message ids quickly: UID, flags, date and size, with no envelope and no body", async () => {
  fake = await serve()
  const source = sourceOf(fake.port)
  const searched = await source.search?.(FROM, "INBOX")
  const quick = await source.quick?.(FROM, "INBOX", { searched: searched as Searched })
  const full = await source.list(FROM, "INBOX")
  await source.close()
  const fetches = fake.commands.filter((command) => command.startsWith("UID FETCH"))
  expect(fetches[0]).toMatch(/FLAGS/)
  expect(fetches[0]).not.toMatch(/ENVELOPE|BODY/i)
  expect(quick?.map(({ uid, seen, flagged, size, receivedAt }) => ({ uid, seen, flagged, size, receivedAt }))).toEqual(
    full.map(({ uid, seen, flagged, size, receivedAt }) => ({ uid, seen, flagged, size, receivedAt })),
  )
})

const serveMessages = (messages: FakeMessage[]) =>
  startFakeImap({
    login: "ya@burobiz.ru",
    password: "app-secret-1",
    folders: [{ name: "INBOX", messages }],
  })

it("does not call a listing quick when the server gives message ids", async () => {
  fake = await serveMessages([{ uid: 4, raw: raw("a", "first"), emailId: "E1", threadId: "T1" }])
  const source = sourceOf(fake.port)
  const searched = await source.search?.(FROM, "INBOX")
  await source.close()
  expect(searched?.quick).toBeUndefined()
})

it("gives mail read as bytes the id the envelope listing gives it, a folded or missing Message-ID included", async () => {
  fake = await serveMessages([
    { uid: 4, raw: raw("a", "plain") },
    { uid: 5, raw: raw("b", "folded").replace("Message-ID: <b@example.com>", "Message-ID:\r\n <b@example.com>") },
    { uid: 6, raw: raw("c", "none").replace(/Message-ID:.*\r\n/, "") },
  ])
  const source = sourceOf(fake.port)
  const searched = (await source.search?.(FROM, "INBOX")) as Searched
  const full = await source.list(FROM, "INBOX", { searched })
  const quick = (await source.quick?.(FROM, "INBOX", { searched })) as Quick[]
  const raws = await source.fetchRaw(quick)
  await source.close()
  expect(quick.map((item, index) => source.identify?.(raws[index] as Uint8Array, item))).toEqual(
    full.map(({ messageId, threadId }) => ({ messageId, threadId })),
  )
  expect(new Set(full.map(({ messageId }) => messageId)).size).toBe(3)
})
