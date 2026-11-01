import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { memoryKeyring } from "@wirecat/cli-base"
import { openStore, storePath } from "@wirecat/cli-core/store"
import { afterEach, expect } from "vitest"
import type { MailEnvironment } from "../commands/context.js"
import type { MailCredential, MailEndpoint, RunBounds } from "../mail/backend.js"
import { imapBackend } from "../mail/imap/index.js"
import { run } from "../program.js"
import { type FakeFolder, type FakeImap, type FakeOptions, startFakeImap } from "./fake-imap.js"

export const PASSWORD = "fixture-app-password-7Kq2"
export const ADDRESS = "me@example.com"

export const raw = (id: string, subject: string, body: string, from = "Ann <ann@example.com>", more = "") =>
  `Message-ID: <${id}@example.com>\r\nDate: Tue, 01 Sep 2026 10:00:00 +0000\r\nFrom: ${from}\r\n` +
  `To: ${ADDRESS}\r\n${more}Subject: ${subject}\r\n\r\n${body}\r\n`

export const OLD = "01-Sep-2026 10:00:00 +0000"

let fake: FakeImap | undefined
afterEach(async () => {
  await fake?.close()
  fake = undefined
})

/** A profile signed in to a fake IMAP server and synced once, in throwaway folders; nothing real is touched. */
export const harness = async (given: Partial<FakeOptions> & { provider?: string; folders: FakeFolder[] }) => {
  const { provider, ...fakeOptions } = given
  fake = await startFakeImap({ login: ADDRESS, password: PASSWORD, ...fakeOptions })
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
  const mail = async (argv: string[], extra: Partial<MailEnvironment> & { password?: string; env?: object } = {}) => {
    const out: string[] = []
    const err: string[] = []
    const { password, env: more, ...rest } = extra
    const code = await run(argv, {
      streams: { data: (text) => out.push(text), diagnostic: (text) => err.push(text) },
      tty: false,
      env: { ...env, ...(password === undefined ? {} : { MAIL_PASSWORD: password }), ...more },
      keyring,
      himalaya: async () => undefined,
      discovery: { mx: async () => ["mx.yandex.net"], fetch: async () => new Response("", { status: 404 }) },
      backend: (endpoint: MailEndpoint, secret: MailCredential, bounds: RunBounds = {}) =>
        imapBackend({ ...endpoint, host: "127.0.0.1", port, security: "plain" }, secret, {
          sleep: async () => {},
          ...bounds,
        }),
      ...rest,
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
  const json = async (...argv: string[]) => {
    const answer = await mail(["ya", ...argv, "--json"])
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
  return { mail, json, refOf, env, stored, commands: () => fake?.commands ?? [] }
}
