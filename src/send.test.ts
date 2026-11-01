import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { memoryKeyring } from "@wirecat/cli-base"
import { describeProgram } from "@wirecat/cli-base/commands"
import { toolsFromCommands } from "@wirecat/cli-core/mcp"
import { sendsPathFor } from "@wirecat/cli-core/sends"
import { afterEach, describe, expect, it } from "vitest"

// Each case signs in, syncs and sends over two local servers: seconds on a loaded machine.
import type { MailEnvironment } from "./commands/context.js"
import { configuration } from "./config.js"
import { IDENTITY } from "./identity.js"
import type { MailEndpoint, RunBounds } from "./mail/backend.js"
import { imapBackend } from "./mail/imap/index.js"
import { createProgram, run } from "./program.js"
import { type FakeFolder, type FakeImap, type FakeOptions, startFakeImap } from "./testing/fake-imap.js"
import { type FakeSmtp, type FakeSmtpOptions, startFakeSmtp } from "./testing/fake-smtp.js"
import { mcpClient } from "./testing/mcp.js"

const PASSWORD = "fixture-app-password-7Kq2"
const ADDRESS = "me@example.com"
const OLD = "01-Sep-2026 10:00:00 +0000"

const raw = (
  id: string,
  subject: string,
  body: string,
  headers = "From: Ann <ann@example.com>\r\nTo: me@example.com",
) =>
  `Message-ID: <${id}@example.com>\r\nDate: Tue, 01 Sep 2026 10:00:00 +0000\r\n${headers}\r\nSubject: ${subject}\r\n\r\n${body}\r\n`

const withFile = (id: string, subject: string) =>
  `Message-ID: <${id}@example.com>\r\nDate: Tue, 01 Sep 2026 10:00:00 +0000\r\nFrom: Ann <ann@example.com>\r\n` +
  `To: me@example.com\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="b1"\r\n\r\n` +
  `--b1\r\nContent-Type: text/plain\r\n\r\nThe invoice is attached\r\n` +
  `--b1\r\nContent-Type: application/pdf; name="invoice.pdf"\r\nContent-Disposition: attachment; filename="invoice.pdf"\r\n` +
  `Content-Transfer-Encoding: base64\r\n\r\n${Buffer.from("%PDF-1.4 invoice").toString("base64")}\r\n` +
  `--b1\r\nContent-Type: text/plain; name="../../notes.txt"\r\nContent-Disposition: attachment; filename="../../notes.txt"\r\n\r\n` +
  `secret plan\r\n--b1--\r\n`

const yandex = (): FakeFolder[] => [
  {
    name: "INBOX",
    uidValidity: 11,
    messages: [
      {
        uid: 1,
        raw: raw(
          "invoice",
          "Invoice October",
          "Pay the invoice\r\nby Friday",
          "From: Ann <ann@example.com>\r\nTo: me@example.com, Bob <bob@example.com>\r\nCc: carol@example.com\r\nReferences: <start@example.com>",
        ),
        flags: [],
        date: OLD,
      },
      { uid: 2, raw: withFile("files", "Files for you"), flags: [], date: OLD },
    ],
  },
  { name: "Sent", attributes: ["\\Sent"], uidValidity: 14, messages: [] },
  { name: "Drafts", attributes: ["\\Drafts"], uidValidity: 15, messages: [] },
  { name: "Trash", attributes: ["\\Trash"], uidValidity: 13, messages: [] },
]

let imap: FakeImap | undefined
let smtp: FakeSmtp | undefined
afterEach(async () => {
  await imap?.close()
  await smtp?.close()
  imap = undefined
  smtp = undefined
})

const harness = async (
  given: Partial<FakeOptions> & { mx?: string; smtp?: Partial<FakeSmtpOptions>; smtpPort?: number } = {},
) => {
  const { mx = "mx.yandex.net", smtp: smtpOptions, smtpPort, ...imapOptions } = given
  imap = await startFakeImap({ login: ADDRESS, password: PASSWORD, folders: yandex(), ...imapOptions })
  smtp = await startFakeSmtp({ login: ADDRESS, password: PASSWORD, ...smtpOptions })
  const ports = { imap: imap.port, smtp: smtpPort ?? smtp.port }
  const keyring = memoryKeyring()
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MAIL_CONFIG_DIR: mkdtempSync(join(tmpdir(), "config-")),
    MAIL_STATE_DIR: mkdtempSync(join(tmpdir(), "state-")),
    MEMO_STATE_DIR: mkdtempSync(join(tmpdir(), "memo-state-")),
    MESSAGING_STORE: join(mkdtempSync(join(tmpdir(), "store-")), "wirecat.db"),
  }
  delete env.CI
  const options = (extra: Partial<MailEnvironment> & { password?: string; env?: object } = {}) => {
    const { password, env: more, ...rest } = extra
    return {
      tty: false,
      env: { ...env, ...(password === undefined ? {} : { MAIL_PASSWORD: password }), ...more },
      keyring,
      himalaya: async () => undefined,
      discovery: { mx: async () => [mx], fetch: async () => new Response("", { status: 404 }) },
      stdin: Readable.from([]),
      backend: (endpoint: MailEndpoint, secret: string, bounds: RunBounds = {}) =>
        imapBackend(
          {
            ...endpoint,
            host: "127.0.0.1",
            port: ports.imap,
            security: "plain",
            ...(endpoint.smtp ? { smtp: { host: "127.0.0.1", port: ports.smtp, security: "plain" } } : {}),
          },
          secret,
          { sleep: async () => {}, ...bounds },
        ),
      ...rest,
    } as MailEnvironment & Record<string, unknown>
  }
  const mail = async (argv: string[], extra: Partial<MailEnvironment> & { password?: string; env?: object } = {}) => {
    const out: string[] = []
    const err: string[] = []
    const code = await run(argv, {
      ...options(extra),
      streams: { data: (text) => out.push(text), diagnostic: (text) => err.push(text) },
    } as MailEnvironment & Record<string, unknown>)
    return { code, out: out.join("\n"), err: err.join("\n") }
  }
  const started = await mail(["ya", "session", "start", "--address", ADDRESS, "--json"], { password: PASSWORD })
  expect(started.code, started.err).toBe(0)
  const synced = await mail(["ya", "sync", "--since-time", "2026-01-01", "--json"])
  expect(synced.code, synced.err).toBe(0)
  const refOf = async (word: string): Promise<string> => {
    const found = await mail(["ya", "search", "messages", word, "--json"])
    const items = JSON.parse(found.out).items
    expect(items, word).toHaveLength(1)
    return items[0].ref
  }
  const journal = () => {
    try {
      return readFileSync(sendsPathFor(IDENTITY, "ya", env), "utf8")
    } catch {
      return ""
    }
  }
  return { mail, options, refOf, env, journal, smtp: smtp as FakeSmtp, imap: imap as FakeImap }
}

const item = (text: string) => JSON.parse(text).item
const errorOf = (text: string) => JSON.parse(text).error

describe("messages send over SMTP", { timeout: 20_000 }, () => {
  it("sends to the owner without asking, files a copy in Sent with its Bcc, and stores it", async () => {
    const folders = yandex()
    const { mail, smtp, journal } = await harness({ folders })
    const sent = await mail([
      "ya",
      "messages",
      "send",
      "--to",
      ADDRESS,
      "--bcc",
      "me@example.com",
      "--subject",
      "Note to self",
      "Buy milk",
      "--json",
    ])
    expect(sent.code, sent.err).toBe(0)
    const answer = item(sent.out)
    expect(answer).toMatchObject({ sent: true, accepted: 1, rejected: 0, sent_copy: "appended", stored: true })
    expect(smtp.received).toHaveLength(1)
    const out = smtp.received[0]
    expect(out?.from).toBe(ADDRESS)
    expect(out?.recipients).toEqual([ADDRESS])
    expect(out?.raw).toContain("Subject: Note to self")
    expect(out?.raw).toContain(`Message-ID: ${answer.message_id}`)
    const sentFolder = folders.find(({ name }) => name === "Sent")
    expect(sentFolder?.messages).toHaveLength(1)
    expect(sentFolder?.messages[0]?.flags).toEqual(["\\Seen"])
    expect(sentFolder?.messages[0]?.raw).toContain(answer.message_id)
    const line = journal().trim().split("\n").at(-1) ?? ""
    expect(line).toContain('"outcome":"sent"')
    for (const secret of ["Buy milk", "Note to self", ADDRESS]) expect(line).not.toContain(secret)
    const found = await mail(["ya", "search", "messages", "subject:self", "--json"])
    expect(JSON.parse(found.out).items).toHaveLength(1)
  })

  it("keeps Bcc out of what goes, and in the copy for Sent", async () => {
    const folders = yandex()
    const { mail, smtp } = await harness({ folders })
    const sent = await mail([
      "ya",
      "messages",
      "send",
      "--to",
      "ann@example.com",
      "--bcc",
      "boss@example.com",
      "--subject",
      "Hi",
      "Hello",
      "--yes",
      "--json",
    ])
    expect(sent.code, sent.err).toBe(0)
    expect(smtp.received[0]?.recipients.sort()).toEqual(["ann@example.com", "boss@example.com"])
    expect(smtp.received[0]?.raw).not.toMatch(/^Bcc:/im)
    expect(folders.find(({ name }) => name === "Sent")?.messages[0]?.raw).toMatch(/^Bcc: boss@example\.com/im)
  })

  it("asks before mail to anyone else: with nobody at a terminal it is refused and journaled, nothing goes", async () => {
    const { mail, smtp, journal } = await harness()
    const refused = await mail([
      "ya",
      "messages",
      "send",
      "--to",
      "ann@example.com",
      "--subject",
      "Hi",
      "Hello",
      "--json",
    ])
    expect(refused.code).toBe(7)
    expect(errorOf(refused.err).code).toBe("confirmation_required")
    expect(refused.err).toContain("messages.send.others")
    expect(smtp.received).toHaveLength(0)
    expect(smtp.logins).toBe(0)
    expect(journal()).toContain('"outcome":"refused"')
  })

  it("puts the whole outgoing mail before the terminal's question, and sends on yes", async () => {
    const { mail, smtp } = await harness()
    const asked: string[] = []
    const sent = await mail(
      ["ya", "messages", "send", "--to", "Ann <ann@example.com>", "--subject", "Lunch", "See you\nat noon"],
      {
        answer: async (question: string) => {
          asked.push(question)
          return "y"
        },
      } as Partial<MailEnvironment>,
    )
    expect(sent.code, sent.err).toBe(0)
    expect(sent.err).toContain("About to send:")
    expect(sent.err).toContain("To:      Ann <ann@example.com>")
    expect(sent.err).toContain("Subject: Lunch")
    expect(sent.err).toContain("  at noon")
    expect(asked[0]).toContain("messages.send.others")
    expect(smtp.received).toHaveLength(1)
  })

  it("sends to others without asking once the owner allows it", async () => {
    const { mail, smtp } = await harness()
    expect((await mail(["ya", "config", "set", "permissions.messages.send.others", "allow"])).code).toBe(0)
    const sent = await mail(["ya", "messages", "send", "--to", "ann@example.com", "--subject", "Hi", "Hello", "--json"])
    expect(sent.code, sent.err).toBe(0)
    expect(smtp.received).toHaveLength(1)
  })

  it("never sends under the read-only lock or a readonly level, whatever --yes says; --dry-run previews", async () => {
    const { mail, smtp } = await harness()
    const argv = ["ya", "messages", "send", "--to", "ann@example.com", "--subject", "Hi", "Hello", "--yes", "--json"]
    const locked = await mail(argv, { env: { MAIL_READ_ONLY: "1" } })
    expect(errorOf(locked.err).code).toBe("permission_error")
    expect(errorOf((await mail([...argv, "--dry-run"], { env: { MAIL_READ_ONLY: "1" } })).err).code).toBe(
      "permission_error",
    )
    const preview = await mail([...argv, "--dry-run"])
    expect(preview.code, preview.err).toBe(0)
    expect(item(preview.out)).toMatchObject({ sent: false, to: ["ann@example.com"], subject: "Hi" })
    expect((await mail(["ya", "config", "set", "permissions.messages.send", "readonly"])).code).toBe(0)
    const readonly = await mail(argv)
    expect(errorOf(readonly.err).code).toBe("permission_error")
    expect(smtp.received).toHaveLength(0)
  })

  it("stops at the hourly limit, each recipient counted", async () => {
    const { mail, smtp } = await harness()
    const limit = await mail(["ya", "config", "set", "sends_per_hour", "2"])
    expect(limit.code, limit.err).toBe(0)
    const first = await mail([
      "ya",
      "messages",
      "send",
      "--to",
      "a@example.com,b@example.com",
      "--subject",
      "1",
      "one",
      "--yes",
      "--json",
    ])
    expect(first.code, first.err).toBe(0)
    const second = await mail([
      "ya",
      "messages",
      "send",
      "--to",
      "c@example.com",
      "--subject",
      "2",
      "two",
      "--yes",
      "--json",
    ])
    expect(errorOf(second.err).code).toBe("rate_limited")
    expect(smtp.received).toHaveLength(1)
  })

  it("attaches files named on the command line, and refuses a credential file without --allow-any-file", async () => {
    const { mail, smtp } = await harness()
    const dir = mkdtempSync(join(tmpdir(), "files-"))
    const report = join(dir, "report.txt")
    writeFileSync(report, "quarterly numbers")
    const sent = await mail([
      "ya",
      "messages",
      "send",
      "--to",
      ADDRESS,
      "--subject",
      "Report",
      "Here it is",
      "--file",
      report,
      "--json",
    ])
    expect(sent.code, sent.err).toBe(0)
    expect(item(sent.out).attachments).toEqual([{ name: "report.txt", bytes: 17 }])
    expect(smtp.received[0]?.raw).toContain("filename=report.txt")
    mkdirSync(join(dir, ".ssh"))
    writeFileSync(join(dir, ".ssh", "id_ed25519"), "key")
    const refused = await mail([
      "ya",
      "messages",
      "send",
      "--to",
      ADDRESS,
      "--subject",
      "Key",
      "x",
      "--file",
      join(dir, ".ssh", "id_ed25519"),
      "--json",
    ])
    expect(errorOf(refused.err).code).toBe("validation_error")
    expect(smtp.received).toHaveLength(1)
    const meant = await mail([
      "ya",
      "messages",
      "send",
      "--to",
      ADDRESS,
      "--cc",
      ADDRESS,
      "--subject",
      "Key",
      "x",
      "--file",
      join(dir, ".ssh", "id_ed25519"),
      "--allow-any-file",
      "--json",
    ])
    expect(meant.code, meant.err).toBe(0)
    expect(smtp.received).toHaveLength(2)
  })

  it("warns when the text speaks of an attachment and none is given", async () => {
    const { mail } = await harness()
    const sent = await mail(["ya", "messages", "send", "--to", ADDRESS, "--subject", "x", "See the attached file"])
    expect(sent.code, sent.err).toBe(0)
    expect(sent.err).toContain("nothing is attached")
  })

  it("reads the text from stdin when none is given", async () => {
    const { mail, smtp } = await harness()
    const sent = await mail(["ya", "messages", "send", "--to", ADDRESS, "--subject", "Piped", "--json"], {
      stdin: Readable.from(["from a pipe\n"]),
    } as Partial<MailEnvironment>)
    expect(sent.code, sent.err).toBe(0)
    expect(smtp.received[0]?.raw).toContain("from a pipe")
  })

  it("leaves the copy to Gmail, which files sent mail itself", async () => {
    const folders: FakeFolder[] = [
      { name: "INBOX", uidValidity: 21, messages: [] },
      { name: "[Gmail]/All Mail", attributes: ["\\All"], uidValidity: 22, messages: [] },
      { name: "[Gmail]/Sent Mail", attributes: ["\\Sent"], uidValidity: 23, messages: [] },
    ]
    const { mail, imap } = await harness({ folders, gmail: true, mx: "aspmx.l.google.com" })
    const sent = await mail(["ya", "messages", "send", "--to", ADDRESS, "--subject", "x", "y", "--json"])
    expect(sent.code, sent.err).toBe(0)
    expect(item(sent.out).sent_copy).toBe("server")
    expect(imap.commands.some((line) => line.startsWith("APPEND"))).toBe(false)
  })

  it("answers authentication_error, nothing sent, when SMTP refuses the app password", async () => {
    const { mail } = await harness({ smtp: { password: "another" } })
    const failed = await mail(["ya", "messages", "send", "--to", ADDRESS, "--subject", "x", "y", "--json"])
    const error = errorOf(failed.err)
    expect(error.code).toBe("authentication_error")
    expect(error.details?.sent ?? error.sent).toBe(false)
  })

  it("tells a refusal it may retry from one it may not, both with nothing sent", async () => {
    for (const [code, expected] of [
      [451, "provider_unavailable"],
      [554, "provider_error"],
    ] as const) {
      const { mail, journal } = await harness({ smtp: { onData: { code, message: "no" } } })
      const failed = await mail(["ya", "messages", "send", "--to", ADDRESS, "--subject", "x", "y", "--json"])
      const error = errorOf(failed.err)
      expect(error.code).toBe(expected)
      expect(error.details?.sent ?? error.sent).toBe(false)
      expect(journal()).toContain('"outcome":"failed"')
      await imap?.close()
      await smtp?.close()
    }
  })

  it("answers network_error, nothing sent, when the submission server cannot be reached", async () => {
    const closed = createServer()
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve))
    const port = (closed.address() as { port: number }).port
    await new Promise((resolve) => closed.close(resolve))
    const { mail } = await harness({ smtpPort: port })
    const failed = await mail(["ya", "messages", "send", "--to", ADDRESS, "--subject", "x", "y", "--json"])
    expect(errorOf(failed.err).code).toBe("network_error")
  })

  it("sends where the mailbox has no Sent folder, and says the copy had nowhere to go", async () => {
    const folders = yandex().filter(({ name }) => name !== "Sent")
    const { mail } = await harness({ folders })
    const sent = await mail(["ya", "messages", "send", "--to", ADDRESS, "--subject", "x", "y", "--json"])
    expect(sent.code, sent.err).toBe(0)
    expect(item(sent.out).sent_copy).toBe("no-sent-folder")
  })

  it("never saves attachments into a credential folder", async () => {
    const { mail, refOf } = await harness()
    const ssh = join(mkdtempSync(join(tmpdir(), "home-")), ".ssh")
    const refused = await mail([
      "ya",
      "attachments",
      "download",
      await refOf("subject:Files"),
      "--output-dir",
      ssh,
      "--json",
    ])
    expect(errorOf(refused.err).code).toBe("validation_error")
  })

  it("answers people with a line, and the text of what it sent", async () => {
    const { mail, refOf } = await harness()
    const sent = await mail(["ya", "messages", "send", "--to", ADDRESS, "--subject", "Plain", "words"], {
      tty: true,
    } as Partial<MailEnvironment>)
    expect(sent.code, sent.err).toBe(0)
    expect(sent.out).toContain("sent to 1 recipient: Plain")
    const listed = await mail(["ya", "attachments", "list", await refOf("subject:October")], {
      tty: true,
    } as Partial<MailEnvironment>)
    expect(listed.out).toContain("no attachments")
    const files = await mail(["ya", "attachments", "list", await refOf("subject:Files")], {
      tty: true,
    } as Partial<MailEnvironment>)
    expect(files.out).toContain("1  invoice.pdf  16 bytes")
  })

  it("calls a broken line after the message went outcome_unknown, and a retry finds it in Sent instead of sending twice", async () => {
    const folders = yandex()
    const { mail, smtp, journal } = await harness({ folders, smtp: { onData: "drop" } })
    const argv = ["ya", "messages", "send", "--to", ADDRESS, "--subject", "Once", "only once", "--json"]
    const lost = await mail(argv)
    const error = errorOf(lost.err)
    expect(error.code).toBe("outcome_unknown")
    const operationId = error.details?.operation_id ?? error.operation_id
    expect(typeof operationId).toBe("string")
    expect(journal()).toContain('"outcome":"outcome_unknown"')
    folders
      .find(({ name }) => name === "Sent")
      ?.messages.push({ uid: 7, raw: raw(operationId, "Once", "only once", `From: ${ADDRESS}\r\nTo: ${ADDRESS}`) })
    const retried = await mail([...argv, "--operation-id", operationId])
    expect(retried.code, retried.err).toBe(0)
    expect(item(retried.out)).toMatchObject({ sent: false, already_sent: true, operation_id: operationId })
    expect(smtp.received).toHaveLength(0)
  })
})

describe("replies and forwards", { timeout: 20_000 }, () => {
  it("replies with In-Reply-To, References, Re: and the quote, and marks the original answered", async () => {
    const folders = yandex()
    const { mail, refOf, smtp, imap } = await harness({ folders })
    const ref = await refOf("subject:October")
    const sent = await mail(["ya", "messages", "send", "--reply-to", ref, "Paid today", "--yes", "--json"])
    expect(sent.code, sent.err).toBe(0)
    const answer = item(sent.out)
    expect(answer).toMatchObject({ subject: "Re: Invoice October", to: ["Ann <ann@example.com>"], cc: [] })
    expect(answer.marked_original).toBe(true)
    const out = smtp.received[0]?.raw ?? ""
    expect(out).toContain("In-Reply-To: <invoice@example.com>")
    expect(out).toMatch(/References: <start@example\.com>\s+<invoice@example\.com>/)
    expect(out).toContain("Paid today")
    expect(out).toContain("> Pay the invoice")
    expect(out).toContain("> by Friday")
    expect(imap.commands).toContain("UID STORE 1 +FLAGS (\\Answered)")
    expect(folders[0]?.messages[0]?.flags).toContain("\\Answered")
  })

  it("replies to all but the owner with --reply-all", async () => {
    const { mail, refOf, smtp } = await harness()
    const sent = await mail([
      "ya",
      "messages",
      "send",
      "--reply-to",
      await refOf("subject:October"),
      "--reply-all",
      "Thanks all",
      "--yes",
      "--json",
    ])
    expect(sent.code, sent.err).toBe(0)
    expect(item(sent.out)).toMatchObject({
      to: ["Ann <ann@example.com>"],
      cc: ["Bob <bob@example.com>", "carol@example.com"],
    })
    expect(smtp.received[0]?.recipients.sort()).toEqual(["ann@example.com", "bob@example.com", "carol@example.com"])
  })

  it("forwards the original attached whole, Fwd:, and marks it $Forwarded", async () => {
    const folders = yandex()
    const { mail, refOf, smtp } = await harness({ folders })
    const sent = await mail([
      "ya",
      "messages",
      "forward",
      await refOf("subject:October"),
      "--to",
      "bob@example.com",
      "FYI",
      "--yes",
      "--json",
    ])
    expect(sent.code, sent.err).toBe(0)
    expect(item(sent.out)).toMatchObject({ subject: "Fwd: Invoice October", to: ["bob@example.com"] })
    const out = smtp.received[0]?.raw ?? ""
    expect(out).toContain("Content-Type: message/rfc822")
    expect(out).toContain("Message-ID: <invoice@example.com>")
    expect(out).toContain("FYI")
    expect(folders[0]?.messages[0]?.flags).toContain("$Forwarded")
  })

  it("forwards with copies, a file and its own subject; --dry-run sends nothing, --operation-id keeps the Message-ID", async () => {
    const { mail, refOf, smtp } = await harness()
    const ref = await refOf("subject:October")
    const dir = mkdtempSync(join(tmpdir(), "files-"))
    writeFileSync(join(dir, "note.txt"), "see this")
    const argv = [
      "ya",
      "messages",
      "forward",
      ref,
      "--to",
      "bob@example.com",
      "--cc",
      "carol@example.com",
      "--bcc",
      "dave@example.com",
      "--subject",
      "Please pay",
      "--file",
      join(dir, "note.txt"),
      "--allow-any-file",
      "--operation-id",
      "1234567890",
      "--yes",
      "--json",
    ]
    const preview = await mail([...argv, "--dry-run"])
    expect(preview.code, preview.err).toBe(0)
    expect(item(preview.out)).toMatchObject({ sent: false, subject: "Please pay" })
    expect(smtp.received).toHaveLength(0)
    const sent = await mail(argv)
    expect(sent.code, sent.err).toBe(0)
    expect(item(sent.out).message_id).toBe("<1234567890@example.com>")
    expect(smtp.received[0]?.recipients.sort()).toEqual(["bob@example.com", "carol@example.com", "dave@example.com"])
    expect(smtp.received[0]?.raw).toContain("filename=note.txt")
  })

  it("asks before a forward to anyone else, as before a send", async () => {
    const { mail, refOf, smtp } = await harness()
    const refused = await mail([
      "ya",
      "messages",
      "forward",
      await refOf("subject:October"),
      "--to",
      "eve@example.com",
      "--json",
    ])
    expect(errorOf(refused.err).code).toBe("confirmation_required")
    expect(smtp.received).toHaveLength(0)
  })
})

describe("attachments list and download", { timeout: 20_000 }, () => {
  it("lists the attachments by number, as the server holds them", async () => {
    const { mail, refOf } = await harness()
    const listed = await mail(["ya", "attachments", "list", await refOf("subject:Files"), "--json"])
    expect(listed.code, listed.err).toBe(0)
    expect(JSON.parse(listed.out).items).toEqual([
      { number: 1, name: "invoice.pdf", mime: "application/pdf", bytes: 16 },
      { number: 2, name: "notes.txt", mime: "text/plain", bytes: 11 },
    ])
  })

  it("saves private files under their plain names, never overwrites without --replace, and peeks", async () => {
    const folders = yandex()
    const { mail, refOf, imap } = await harness({ folders })
    const ref = await refOf("subject:Files")
    const out = join(mkdtempSync(join(tmpdir(), "out-")), "invoices")
    const saved = await mail(["ya", "attachments", "download", ref, "--output-dir", out, "--json"])
    expect(saved.code, saved.err).toBe(0)
    expect(item(saved.out).files.map(({ name }: { name: string }) => name)).toEqual(["invoice.pdf", "notes.txt"])
    expect(readFileSync(join(out, "invoice.pdf"), "utf8")).toBe("%PDF-1.4 invoice")
    expect(readFileSync(join(out, "notes.txt"), "utf8")).toBe("secret plan")
    if (process.platform !== "win32") {
      expect(statSync(join(out, "invoice.pdf")).mode & 0o777).toBe(0o600)
      expect(statSync(out).mode & 0o777).toBe(0o700)
    }
    writeFileSync(join(out, "invoice.pdf"), "mine")
    const again = await mail(["ya", "attachments", "download", ref, "1", "--output-dir", out, "--json"])
    expect(errorOf(again.err).code).toBe("validation_error")
    expect(readFileSync(join(out, "invoice.pdf"), "utf8")).toBe("mine")
    const replaced = await mail(["ya", "attachments", "download", ref, "1", "--output-dir", out, "--replace", "--json"])
    expect(replaced.code, replaced.err).toBe(0)
    expect(readFileSync(join(out, "invoice.pdf"), "utf8")).toBe("%PDF-1.4 invoice")
    const none = await mail(["ya", "attachments", "download", ref, "9", "--output-dir", out, "--json"])
    expect(errorOf(none.err).code).toBe("not_found")
    expect(folders[0]?.messages[1]?.flags).not.toContain("\\Seen")
    expect(imap.commands.some((line) => /BODY\[\]/i.test(line) && !/PEEK/i.test(line))).toBe(false)
  })
})

const callSend = (client: Awaited<ReturnType<typeof mcpClient>>["client"], to: string) =>
  client.callTool({
    name: "mail_write",
    arguments: { command: "messages send", arguments: { to, subject: "From the agent", text: "Hello" } },
  }) as Promise<{ isError?: boolean; content?: { text?: string }[] }>

describe("sending over MCP", { timeout: 20_000 }, () => {
  it("lets an agent mail only the owner by default, and names the key that opens it", async () => {
    const { options, smtp } = await harness()
    const { client, close } = await mcpClient(options() as Parameters<typeof mcpClient>[0], [], "ya")
    try {
      const refused = await callSend(client, "eve@example.com")
      expect(refused.isError).toBe(true)
      const text = JSON.stringify(refused.content)
      expect(text).toContain("permission_error")
      expect(text).toContain("config set permissions.messages.send.others allow")
      expect((await callSend(client, ADDRESS)).isError).not.toBe(true)
    } finally {
      expect(await close()).toBe(0)
    }
    expect(smtp.received.map(({ recipients }) => recipients)).toEqual([[ADDRESS]])
  })

  it("lets an agent mail others once the owner allows it in the config", async () => {
    const { mail, options, smtp } = await harness()
    expect((await mail(["ya", "config", "set", "permissions.messages.send.others", "allow"])).code).toBe(0)
    const { client, close } = await mcpClient(options() as Parameters<typeof mcpClient>[0], [], "ya")
    try {
      const sent = await callSend(client, "ann@example.com")
      expect(sent.isError, JSON.stringify(sent)).not.toBe(true)
    } finally {
      expect(await close()).toBe(0)
    }
    expect(smtp.received.map(({ recipients }) => recipients)).toEqual([["ann@example.com"]])
  })

  it("does not let an mcp serve --permission open mail to others", async () => {
    const { options, smtp } = await harness()
    const { client, close } = await mcpClient(
      options() as Parameters<typeof mcpClient>[0],
      ["--permission", "messages.send.others=ask"],
      "ya",
    )
    try {
      expect((await callSend(client, "eve@example.com")).isError).toBe(true)
    } finally {
      expect(await close()).toBe(0)
    }
    expect(smtp.received).toHaveLength(0)
  })

  it("lets the owner fence an agent to mail only the owner, with messages.send.others=readonly", async () => {
    const { options, smtp } = await harness()
    const { client, close } = await mcpClient(
      options() as Parameters<typeof mcpClient>[0],
      ["--permission", "messages.send.others=readonly"],
      "ya",
    )
    try {
      const send = (to: string) =>
        client.callTool({
          name: "mail_write",
          arguments: { command: "messages send", arguments: { to, subject: "From the agent", text: "Hello" } },
        })
      const refused = (await send("eve@example.com")) as { isError?: boolean; content?: { text?: string }[] }
      expect(refused.isError).toBe(true)
      expect(JSON.stringify(refused.content)).toContain("permission_error")
      const own = (await send(ADDRESS)) as { isError?: boolean }
      expect(own.isError, JSON.stringify(own)).not.toBe(true)
    } finally {
      expect(await close()).toBe(0)
    }
    expect(smtp.received.map(({ recipients }) => recipients)).toEqual([[ADDRESS]])
  })
  it("lets an agent attach a file, but never one from a credential folder: --allow-any-file is the owner's", async () => {
    const tools = toolsFromCommands(describeProgram(createProgram()), { permissions: configuration.permissions })
    for (const command of ["messages send", "messages forward"]) {
      const entries = tools.find((tool) => tool.command === command)?.input.entries ?? {}
      expect(entries, command).toHaveProperty("file")
      expect(entries, command).not.toHaveProperty("allow_any_file")
    }
    const { options, smtp } = await harness()
    const dir = mkdtempSync(join(tmpdir(), "files-"))
    mkdirSync(join(dir, ".ssh"))
    const key = join(dir, ".ssh", "id_ed25519")
    writeFileSync(key, "key")
    const { client, close } = await mcpClient(options() as Parameters<typeof mcpClient>[0], [], "ya")
    try {
      const send = (extra: Record<string, unknown>) =>
        client.callTool({
          name: "mail_write",
          arguments: { command: "messages send", arguments: { to: ADDRESS, subject: "Key", text: "x", ...extra } },
        }) as Promise<{ isError?: boolean; content?: { text?: string }[] }>
      const refused = await send({ file: key })
      expect(refused.isError).toBe(true)
      expect(JSON.stringify(refused.content)).toContain("--allow-any-file")
      expect((await send({ file: key, allow_any_file: true })).isError).toBe(true)
    } finally {
      expect(await close()).toBe(0)
    }
    expect(smtp.received).toHaveLength(0)
  })
})

describe("settings an agent cannot change", { timeout: 20_000 }, () => {
  it("refuses an agent with mcp.authority the mail servers and permissions.messages.send.others", async () => {
    const { mail, options, env } = await harness()
    expect((await mail(["ya", "config", "set", "permissions.mcp.authority", "allow"])).code).toBe(0)
    const { client, close } = await mcpClient(options() as Parameters<typeof mcpClient>[0], [], "ya")
    try {
      const set = (setting: string, value: string) =>
        client.callTool({
          name: "mail_write",
          arguments: { command: "config set", arguments: { setting, value } },
        }) as Promise<{ isError?: boolean; content?: { text?: string }[] }>
      for (const [setting, value] of [
        ["smtp_host", "smtp.evil.example"],
        ["imap_host", "imap.evil.example"],
        ["permissions.messages.send.others", "allow"],
        ["permissions", '{"messages.send.others":"allow"}'],
      ]) {
        const refused = await set(setting as string, value as string)
        expect(refused.isError, setting).toBe(true)
        expect(JSON.stringify(refused.content), setting).toContain("the owner sets it in a terminal")
      }
      expect((await set("limit", "5")).isError).not.toBe(true)
    } finally {
      expect(await close()).toBe(0)
    }
    const config = JSON.parse(readFileSync(join(env.MAIL_CONFIG_DIR as string, "config.json"), "utf8"))
    expect(JSON.stringify(config)).not.toContain("evil.example")
    expect(JSON.stringify(config)).not.toContain("send.others")
    expect((await mail(["ya", "config", "set", "smtp_host", "smtp.example.com"])).code).toBe(0)
  })
})

describe("drafts send", { timeout: 20_000 }, () => {
  it("sends a saved draft through the same guard as messages send, then takes it out of Drafts", async () => {
    const folders = yandex()
    const { mail, smtp, journal } = await harness({ folders })
    const created = await mail([
      "ya",
      "drafts",
      "create",
      "--to",
      "ann@example.com",
      "--subject",
      "Plan",
      "Draft text",
      "--json",
    ])
    expect(created.code, created.err).toBe(0)
    const id = item(created.out).id
    const preview = await mail(["ya", "drafts", "send", id, "--dry-run", "--operation-id", "424242424242", "--json"])
    expect(item(preview.out)).toMatchObject({ sent: false, message_id: "<424242424242@example.com>" })
    const asked = await mail(["ya", "drafts", "send", id, "--json"])
    expect(errorOf(asked.err).code).toBe("confirmation_required")
    expect(smtp.received).toHaveLength(0)
    const sent = await mail(["ya", "drafts", "send", id, "--yes", "--json"])
    expect(sent.code, sent.err).toBe(0)
    expect(item(sent.out)).toMatchObject({ sent: true, subject: "Plan", to: ["ann@example.com"] })
    expect(smtp.received[0]?.raw).toContain("Draft text")
    expect(folders.find(({ name }) => name === "Drafts")?.messages).toHaveLength(0)
    expect(journal()).toContain('"key":"messages.send"')
  })
})
