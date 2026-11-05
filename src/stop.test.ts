import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { MailCredential, MailEndpoint, RunBounds } from "./mail/backend.js"
import { imapBackend } from "./mail/imap/index.js"
import type { FakeFolder } from "./testing/fake-imap.js"
import { harness, OLD, raw } from "./testing/mailbox.js"

/** The source of one run: its second read stops the run and takes a while; a third would never answer. */
const stopping = () => {
  const stop = new AbortController()
  const seen = { fetches: 0, secondDone: false }
  const wrap = <S extends object>(source: S, fetchBatch?: number): S =>
    new Proxy(source, {
      get(target, key) {
        if (key === "fetchBatch" && fetchBatch !== undefined) return fetchBatch
        const value = Reflect.get(target, key)
        if (key !== "fetchRaw" || typeof value !== "function")
          return typeof value === "function" ? value.bind(target) : value
        return async (...given: unknown[]) => {
          seen.fetches += 1
          if (seen.fetches > 2) return new Promise(() => {})
          const read = await value.apply(target, given)
          if (seen.fetches === 2) {
            stop.abort()
            await new Promise((done) => setTimeout(done, 300))
            seen.secondDone = true
          }
          return read
        }
      },
    })
  return { signal: stop.signal, seen, wrap }
}

const source = vi.hoisted(() => ({ wrap: undefined as (<S extends object>(one: S) => S) | undefined }))
vi.mock("./mail/mbox.js", async (original) => {
  const real = await original<typeof import("./mail/mbox.js")>()
  return {
    ...real,
    mboxSource: (...given: Parameters<typeof real.mboxSource>) => {
      const made = real.mboxSource(...given)
      return source.wrap ? source.wrap(made) : made
    },
  }
})
afterEach(() => {
  source.wrap = undefined
})

const inbox = (): FakeFolder[] => [
  { name: "INBOX", messages: [] },
  { name: "Sent", attributes: ["\\Sent"], messages: [] },
]

describe("a stop signal", { timeout: 30_000 }, () => {
  it("lets sync finish the read in flight, keep what it saved, and stop before the next", async () => {
    const folders = inbox()
    const box = await harness({ folders })
    for (let uid = 1; uid <= 5; uid++)
      folders[0]?.messages.push({ uid, raw: raw(`m${uid}`, `Note ${uid}`, "text"), flags: [], date: OLD })
    const run = stopping()
    const backend = (endpoint: MailEndpoint, secret: MailCredential, bounds: RunBounds = {}) =>
      run.wrap(
        imapBackend({ ...endpoint, host: "127.0.0.1", port: box.port, security: "plain" }, secret, {
          sleep: async () => {},
          ...bounds,
        }),
        1,
      )
    const started = Date.now()
    const stopped = await box.mail(["ya", "sync", "--since-time", "2026-01-01", "--json"], {
      backend,
      signal: run.signal,
    })
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(run.seen).toEqual({ fetches: 2, secondDone: true })
    expect(stopped.code).not.toBe(0)
    const saved = await box.stored(async (store, id) => (await store.mail.emails({ accountId: id })).length)
    expect(saved).toBe(1)

    const rest = await box.mail(["ya", "sync", "--since-time", "2026-01-01", "--json"])
    expect(rest.code, rest.err).toBe(0)
    expect(await box.stored(async (store, id) => (await store.mail.emails({ accountId: id })).length)).toBe(5)
  })

  it("lets messages import finish the read in flight, keep what it saved, and stop before the next", async () => {
    const box = await harness({
      provider: "gmail",
      folders: [{ name: "[Gmail]/All Mail", attributes: ["\\All"], messages: [] }],
    })
    const file = join(mkdtempSync(join(tmpdir(), "takeout-")), "all.mbox")
    writeFileSync(
      file,
      Array.from(
        { length: 60 },
        (_, index) =>
          `From ${1700000000000000100n + BigInt(index)}@xxx Mon Jul 24 10:00:00 +0000 2023\n` +
          `X-GM-THRID: ${1700000000000000100n + BigInt(index)}\nX-Gmail-Labels: Opened\n` +
          `Message-ID: <takeout-${index}@example.com>\nFrom: Ann <ann@example.com>\nTo: me@example.com\n` +
          `Subject: Note ${index}\n\nbody\n\n`,
      ).join(""),
    )
    const run = stopping()
    source.wrap = (made) => run.wrap(made)
    const started = Date.now()
    const stopped = await box.mail(["ya", "messages", "import", file, "--json"], { signal: run.signal })
    source.wrap = undefined
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(run.seen).toEqual({ fetches: 2, secondDone: true })
    expect(stopped.code).not.toBe(0)
    const count = () => box.stored(async (store, id) => (await store.mail.emails({ accountId: id })).length)
    expect(await count()).toBe(50)

    const rest = await box.mail(["ya", "messages", "import", file, "--json"])
    expect(rest.code, rest.err).toBe(0)
    expect(await count()).toBe(60)
  })
})
