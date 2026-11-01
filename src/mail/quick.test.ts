import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resumeKey, syncMail } from "@wirecat/cli-core/mail"
import { afterEach, expect, it } from "vitest"
import { openMailStore } from "../store.js"
import { type FakeImap, startFakeImap } from "../testing/fake-imap.js"
import { passwordCredential } from "./backend.js"
import { imapBackend } from "./imap/index.js"

const LOGIN = "me@example.com"
const raw = (id: string, subject: string) =>
  `Message-ID: <${id}@example.com>\r\nDate: Tue, 27 Oct 2026 10:00:00 +0000\r\nFrom: Ann <ann@example.com>\r\nTo: ${LOGIN}\r\nSubject: ${subject}\r\n\r\nHello ${subject}\r\n`

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

const harness = async () => {
  const fake: FakeImap = await startFakeImap({
    login: LOGIN,
    password: "app-secret-1",
    folders: [
      {
        name: "INBOX",
        messages: [
          { uid: 4, raw: raw("a", "first") },
          { uid: 7, raw: raw("b", "second") },
        ],
      },
    ],
  })
  const dir = await mkdtemp(join(tmpdir(), "mail-quick-"))
  const store = await openMailStore({ ...process.env, MESSAGING_STORE: join(dir, "wirecat.db") })
  const source = imapBackend(
    { host: "127.0.0.1", port: fake.port, security: "plain", login: LOGIN },
    passwordCredential("app-secret-1"),
  )
  cleanups.push(
    () => fake.close(),
    () => source.close(),
    () => store.close(),
    () => rm(dir, { recursive: true, force: true }),
  )
  const sync = (over = source) =>
    syncMail(over, store, {
      account: { address: LOGIN, mode: "imap", folders: ["INBOX"] },
      since: new Date("2026-10-01"),
      now: () => Date.parse("2026-10-30T10:00:00Z"),
    })
  const bodies = () => fake.commands.filter((command) => /BODY\.PEEK\[\]|BODY\[\]/i.test(command)).length
  const ids = async () => {
    const accountId = (await store.accounts.storedAccount({ provider: "email", account: LOGIN })).id
    return (await store.mail.emails({ accountId })).map(({ externalId }) => externalId).sort()
  }
  const headerListing = {
    ...source,
    search: async (...args: Parameters<NonNullable<typeof source.search>>) => {
      const { quick: _, ...searched } = await (source.search as NonNullable<typeof source.search>)(...args)
      return searched
    },
  }
  return { source, store, sync, bodies, ids, fake, headerListing }
}

it("stores mail under the same ids as the header listing and does not read stored mail again", async () => {
  const { sync, headerListing, bodies, ids, fake } = await harness()
  await sync(headerListing)
  const stored = await ids()
  expect(stored).toHaveLength(2)
  const read = bodies()

  const backfill = await sync()

  expect(backfill).toMatchObject({ saved: 0, listed: 2, alreadyStored: 2, complete: true })
  expect(bodies()).toBe(read)
  expect(fake.commands.filter((command) => /ENVELOPE/i.test(command)).length).toBeGreaterThan(0)
  const again = await sync()

  expect(again).toMatchObject({ saved: 0, listed: 0, complete: true })
  expect(bodies()).toBe(read)
  expect(await ids()).toEqual(stored)
})

it("reads a new message once under the id the header listing would give it", async () => {
  const quicklyAdded = await harness()
  await quicklyAdded.sync()
  const viaBytes = await quicklyAdded.ids()

  const headers = await harness()
  await headers.sync(headers.headerListing)

  expect(viaBytes).toEqual(await headers.ids())
  expect(viaBytes.every((id) => /^imap:[0-9a-f]{64}$/.test(id))).toBe(true)
})

it("recognises stored mail by its header listing when the folder has no resume point, without reading it", async () => {
  const { sync, headerListing, bodies, store, fake } = await harness()
  await sync(headerListing)
  await store.sync.setSyncState({ provider: "email", account: LOGIN }, resumeKey("INBOX"), "")
  fake.commands.length = 0

  expect(await sync()).toMatchObject({ saved: 0, alreadyStored: 2 })
  expect(bodies()).toBe(0)
  expect(fake.commands.some((command) => /ENVELOPE/i.test(command))).toBe(true)
})
