import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GMAIL_ALL_MAIL } from "@wirecat/cli-core/mail"
import { CONTRACT_MAIL, mailSourceContract, mailSyncContract, rawOf } from "@wirecat/cli-core/mail/testing"
import { afterEach, describe, it } from "vitest"
import { openMailStore } from "../store.js"
import { type FakeImap, startFakeImap } from "../testing/fake-imap.js"
import { imapBackend } from "./imap/index.js"

const LOGIN = "owner@example.test"
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const serve = async (): Promise<FakeImap> => {
  const fake = await startFakeImap({
    login: LOGIN,
    password: "app-secret-1",
    // The contract's mail carries server ids, which only Gmail's are taken as they are.
    gmail: true,
    folders: [
      {
        name: GMAIL_ALL_MAIL,
        attributes: ["\\All"],
        messages: CONTRACT_MAIL.map((mail) => ({
          uid: Number(mail.uid),
          raw: Buffer.from(rawOf(mail)).toString("utf8"),
          date: new Date(mail.receivedAt).toUTCString().replace(/^\w+, (\d+) (\w+) (\d+)/, "$1-$2-$3"),
          emailId: mail.messageId,
          threadId: mail.threadId,
        })),
      },
    ],
  })
  cleanups.push(() => fake.close())
  return fake
}

const adapter = async () => {
  const fake = await serve()
  const source = imapBackend({ host: "127.0.0.1", port: fake.port, security: "plain", login: LOGIN }, "app-secret-1")
  cleanups.push(() => source.close())
  return source
}

describe("mailSourceContract over the fake IMAP server", () => {
  for (const { name, run } of mailSourceContract(adapter)) it(name, run)
})

describe("mailSyncContract over the fake IMAP server", () => {
  const make = async () => {
    const dir = await mkdtemp(join(tmpdir(), "mail-contract-"))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const store = await openMailStore({ ...process.env, MESSAGING_STORE: join(dir, "wirecat.db") })
    cleanups.push(() => store.close())
    return { source: await adapter(), store }
  }
  for (const { name, run } of mailSyncContract(make)) it(name, run)
})
