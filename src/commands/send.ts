import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import {
  answerEntity,
  bufferedInput,
  environmentOf,
  itemOf,
  outputFor,
  REMOTE_WRITE,
  renderAnswer,
} from "@wirecat/cli-core/cli"
import { levelFor, newOperationId, readUpload } from "@wirecat/cli-core/sends"
import { Command } from "commander"
import * as v from "valibot"
import { configuration, SEND_OTHERS_KEY } from "../config.js"
import { IDENTITY } from "../identity.js"
import {
  type Draft,
  forgotAttachment,
  forwardSubject,
  messageIdFor,
  originalOf,
  type Person,
  peopleOf,
  quoted,
  referencesOf,
  replyCopies,
  replyPeople,
  replySubject,
} from "../mail/compose.js"
import { everyone, fetchOriginal, type Outgoing, othersOf, type Sending, sendOut } from "../mail/send.js"
import { DEFAULT_SYNC, providerFor } from "../providers.js"
import { collect, contextOf } from "./context.js"
import { type Opened, organising } from "./messages.js"
import { foldersFor } from "./sync.js"

const OPERATION_ID = /^-?[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

interface SendFlags {
  to?: string[]
  cc?: string[]
  bcc?: string[]
  subject?: string
  file?: string[]
  replyTo?: string
  replyAll?: boolean
  operationId?: string
  allowAnyFile?: boolean
  dryRun?: boolean
}

export const mailSend = v.looseObject({
  sent: v.boolean(),
  already_sent: v.optional(v.boolean()),
  operation_id: v.string(),
  message_id: v.string(),
  from: v.string(),
  to: v.array(v.string()),
  cc: v.array(v.string()),
  bcc: v.array(v.string()),
  subject: v.string(),
  attachments: v.array(v.strictObject({ name: v.string(), bytes: v.number() })),
  text_chars: v.number(),
  accepted: v.optional(v.number()),
  rejected: v.optional(v.number()),
  sent_copy: v.optional(v.nullable(v.string())),
  stored: v.optional(v.boolean()),
  marked_original: v.optional(v.nullable(v.boolean())),
  hint: v.optional(v.string()),
})

export const operationIdOf = (given: string | undefined) => {
  if (given === undefined) return newOperationId()
  if (!OPERATION_ID.test(given))
    throw new CliError("validation_error", "--operation-id is the operation_id an outcome_unknown answer named", {
      param: "operation-id",
    })
  return given
}

const ownerOf = (opened: Opened, command: Command): Set<string> => {
  const { mailbox } = contextOf(command).settings
  return new Set(
    [mailbox.address, mailbox.login]
      .filter((one): one is string => typeof one === "string" && one.includes("@"))
      .map((one) => one.toLowerCase())
      .concat(opened.mailbox.key.account),
  )
}

const sendingOf = (opened: Opened, command: Command): Sending => {
  const { settings } = contextOf(command)
  const address = opened.mailbox.key.account
  const provider = providerFor(address, settings.mailbox.host)
  return {
    mailbox: opened.mailbox,
    backend: opened.backend,
    guard: opened.guard,
    profile: opened.profile,
    env: opened.env,
    owner: ownerOf(opened, command),
    savesSent: provider?.smtp.savesSent === true,
    syncFolders: async () => {
      const defaults = provider?.sync ?? DEFAULT_SYNC
      const folders = await foldersFor(undefined, settings.mailbox.folders, defaults, () => opened.mailbox.folders())
      return { folders, mode: defaults.mode ?? "imap" }
    },
    warn: (message) => outputFor(command).renderer.warn(message),
  }
}

export const filesOf = async (command: Command, paths: readonly string[], anyFile: boolean) => {
  const { env } = contextOf(command)
  const files: Draft["files"] = []
  for (const path of paths) {
    const upload = await readUpload("file", path, { app: IDENTITY, env, anyFile })
    if (upload.source.kind !== "file") continue
    files.push({ name: upload.name, path: upload.source.path, bytes: upload.source.size })
  }
  return files
}

const shownPerson = ({ address, name }: Person) => (name ? `${name} <${address}>` : address)

const summaryOf = (draft: Draft) => ({
  from: shownPerson(draft.from),
  to: draft.to.map(shownPerson),
  cc: draft.cc.map(shownPerson),
  bcc: draft.bcc.map(shownPerson),
  subject: draft.subject,
  attachments: [
    ...draft.files.map(({ name, bytes }) => ({ name, bytes })),
    ...(draft.message ? [{ name: draft.message.name, bytes: draft.message.raw.byteLength }] : []),
  ],
  text_chars: draft.text.length,
})

/** What the y/N question shows: everything that leaves, and the start of the text, so a yes is a yes to this mail. */
const summaryText = (draft: Draft) => {
  const summary = summaryOf(draft)
  const lines = draft.text.split("\n").slice(0, 6)
  return [
    "About to send:",
    `  From:    ${summary.from}`,
    `  To:      ${summary.to.join(", ") || "-"}`,
    ...(summary.cc.length ? [`  Cc:      ${summary.cc.join(", ")}`] : []),
    ...(summary.bcc.length ? [`  Bcc:     ${summary.bcc.join(", ")}`] : []),
    `  Subject: ${summary.subject}`,
    ...summary.attachments.map(({ name, bytes }) => `  Attach:  ${name} (${bytes} bytes)`),
    "  ----",
    ...lines.map((line) => `  ${line}`),
    ...(draft.text.split("\n").length > lines.length ? ["  …"] : []),
    "",
  ].join("\n")
}

/** The summary before the terminal's question, only when there is one; an agent's or a `--yes` run asks nothing. */
const showBeforeAsking = (command: Command, draft: Draft, key: string, owner: ReadonlySet<string>) => {
  const given = command.optsWithGlobals<{ yes?: boolean; json?: boolean; jsonl?: boolean }>()
  if (environmentOf(command).agent || given.yes || given.json || given.jsonl) return
  const settings = configuration.resolveSettings(command.optsWithGlobals(), { env: contextOf(command).env })
  const defaults = configuration.permissions?.defaults ?? {}
  const asks = [key, ...(othersOf(draft, owner).length ? [SEND_OTHERS_KEY] : [])].some(
    (one) => levelFor(settings.permissions, one, defaults).level === "ask",
  )
  if (asks) outputFor(command).streams.diagnostic(summaryText(draft))
}

const answer = (command: Command, draft: Draft, outcome: Record<string, unknown>) =>
  renderAnswer(
    command,
    outputFor(command),
    itemOf({ ...outcome, message_id: draft.messageId, ...summaryOf(draft) }),
    () =>
      outcome.sent
        ? `sent to ${everyone(draft).length} ${everyone(draft).length === 1 ? "recipient" : "recipients"}: ${draft.subject}\n`
        : `${String(outcome.hint ?? "not sent")}\n`,
  )

/** Checks, previews or sends, and answers; the outcome of a send that left, for what the caller does after. */
export const go = async (command: Command, opened: Opened, outgoing: Outgoing, dryRun: boolean) => {
  const { draft } = outgoing
  if (everyone(draft).length === 0)
    throw new CliError("validation_error", "the message has nobody to go to; give --to", { param: "to" })
  if (forgotAttachment(draft.text, draft.files.length > 0 || draft.message !== undefined))
    outputFor(command).renderer.warn("the text speaks of an attachment, and nothing is attached (--file)")
  if (dryRun) {
    answer(command, draft, {
      sent: false,
      operation_id: outgoing.operationId,
      hint: "a preview: nothing was sent; the same command without --dry-run sends it",
    })
    return undefined
  }
  const sending = sendingOf(opened, command)
  showBeforeAsking(command, draft, outgoing.key, sending.owner)
  const sent = await sendOut(sending, outgoing)
  answer(command, draft, {
    sent: !sent.alreadySent,
    already_sent: sent.alreadySent,
    operation_id: sent.operationId,
    accepted: sent.accepted,
    rejected: sent.rejected,
    sent_copy: sent.sentCopy,
    stored: sent.stored,
    marked_original: sent.markedOriginal,
    ...(sent.alreadySent
      ? { hint: "Sent already holds this message: it went the first time, and nothing was sent again" }
      : {}),
  })
  return sent
}

const sendAction = async function (this: Command, text: string | undefined, flags: SendFlags) {
  if (flags.replyAll && flags.replyTo === undefined)
    throw new CliError("validation_error", "--reply-all answers the message --reply-to names", { param: "reply-all" })
  if (flags.replyTo === undefined && flags.subject === undefined)
    throw new CliError("validation_error", "a new message needs --subject", { param: "subject" })
  const operationId = operationIdOf(flags.operationId)
  const body = text ?? (await readText(this))
  if (!body.trim() && !flags.file?.length)
    throw new CliError("validation_error", "the message has no text: give it, or pipe it on stdin", { param: "text" })
  const files = await filesOf(this, flags.file ?? [], flags.allowAnyFile === true)
  await organising(this, async (opened) => {
    const from: Person = { address: opened.mailbox.key.account }
    const owner = ownerOf(opened, this)
    const given = {
      to: peopleOf(flags.to ?? [], "--to"),
      cc: peopleOf(flags.cc ?? [], "--cc"),
      bcc: peopleOf(flags.bcc ?? [], "--bcc"),
    }
    let draft: Draft
    let original: Outgoing["original"]
    if (flags.replyTo !== undefined) {
      const fetched = await fetchOriginal(opened.mailbox, opened.backend, flags.replyTo, opened.profile)
      const parent = await originalOf(fetched.raw)
      const to = given.to.length ? given.to : replyPeople(parent, owner, false)
      draft = {
        from,
        to,
        cc: [...(flags.replyAll ? replyCopies(parent, owner, to) : []), ...given.cc],
        bcc: given.bcc,
        subject: flags.subject ?? replySubject(parent.subject),
        text: quoted(body, parent),
        messageId: messageIdFor(operationId, from.address),
        date: new Date(),
        ...(parent.messageId ? { inReplyTo: parent.messageId } : {}),
        references: referencesOf(parent),
        files,
      }
      original = { folder: fetched.folder, validity: fetched.validity, uid: fetched.uid, flag: "\\Answered" }
    } else {
      draft = {
        from,
        ...given,
        subject: flags.subject ?? "",
        text: body,
        messageId: messageIdFor(operationId, from.address),
        date: new Date(),
        files,
      }
    }
    await go(
      this,
      opened,
      {
        draft,
        kind: "message",
        key: "messages.send",
        operationId,
        retry: flags.operationId !== undefined,
        ...(original ? { original } : {}),
      },
      flags.dryRun === true,
    )
  })
}

const readText = async (command: Command): Promise<string> => {
  const input = environmentOf(command).stdin ?? process.stdin
  if ((input as { isTTY?: boolean }).isTTY) return ""
  return (await bufferedInput(input)).toString("utf8")
}

const recipients = (command: Command) =>
  command
    .option(
      "--to <address>",
      "who it goes to: an address, or several split by commas; repeat it for more (a reply: instead of its sender)",
      collect,
    )
    .option("--cc <address>", "a copy to this address; repeat it for more", collect)
    .option("--bcc <address>", "a hidden copy to this address; repeat it for more", collect)

const sending = (command: Command) =>
  command
    .option("--file <file>", "attach this file, as named, never a pattern; repeat it for more", collect)
    .option("--allow-any-file", "attach a file even from credential folders or this CLI's own folders")
    .option("--operation-id <id>", "repeat a send whose outcome was unknown; Sent is checked first, so it goes once")
    .option("--yes", "answer the question before sending to anyone but you")
    .option("--dry-run", "build the message and show what would go; send nothing")

export const sendCommand = (): Command =>
  answerEntity(
    sending(
      recipients(
        annotate(new Command("send"), {
          effects: REMOTE_WRITE,
          examples: [
            `${IDENTITY.command} ya messages send --to ann@example.com --subject "Lunch" "See you at noon."`,
            `${IDENTITY.command} ya messages send --reply-to 'msg:email/me%40example.com/thread-1/1001' "Thanks, done."`,
            `${IDENTITY.command} ya messages send --to ann@example.com --subject Report --file ./report.pdf "The report."`,
          ],
        }),
      ),
    ),
    "mail_send",
    mailSend,
  )
    .summary("send an email, or reply to one, over SMTP")
    .description(
      "send an email from this profile's address over its SMTP server, with the same app password; without [text] " +
        "the text is read from stdin. Mail to anyone but you asks first (permissions.messages.send.others). " +
        "Sent gets a copy where the provider does not file one itself",
    )
    .argument("[text]", "the text of the message; read from stdin when left out")
    .option("--subject <text>", "the subject; a reply takes the original's with Re:")
    .option("--reply-to <message>", "answer this msg:email/… reference: In-Reply-To, References, Re: and the quote")
    .option("--reply-all", "with --reply-to, also to everyone the original went to, except you")
    .action(sendAction)

const forwardAction = async function (this: Command, reference: string, text: string | undefined, flags: SendFlags) {
  const files = await filesOf(this, flags.file ?? [], flags.allowAnyFile === true)
  await organising(this, async (opened) => {
    const operationId = operationIdOf(flags.operationId)
    const fetched = await fetchOriginal(opened.mailbox, opened.backend, reference, opened.profile)
    const parent = await originalOf(fetched.raw)
    const from: Person = { address: opened.mailbox.key.account }
    const subject = flags.subject ?? forwardSubject(parent.subject)
    const draft: Draft = {
      from,
      to: peopleOf(flags.to ?? [], "--to"),
      cc: peopleOf(flags.cc ?? [], "--cc"),
      bcc: peopleOf(flags.bcc ?? [], "--bcc"),
      subject,
      text: text ?? "",
      messageId: messageIdFor(operationId, from.address),
      date: new Date(),
      files,
      message: {
        name: `${(parent.subject || "message").replace(/[\\/:*?"<>|\0]/g, "_").slice(0, 80)}.eml`,
        raw: fetched.raw,
      },
    }
    await go(
      this,
      opened,
      {
        draft,
        kind: "forward",
        key: "messages.forward",
        operationId,
        retry: flags.operationId !== undefined,
        original: { folder: fetched.folder, validity: fetched.validity, uid: fetched.uid, flag: "$Forwarded" },
      },
      flags.dryRun === true,
    )
  })
}

export const forwardCommand = (): Command =>
  answerEntity(
    sending(
      recipients(
        annotate(new Command("forward"), {
          effects: REMOTE_WRITE,
          examples: [
            `${IDENTITY.command} ya messages forward 'msg:email/me%40example.com/thread-1/1001' --to bob@example.com`,
            `${IDENTITY.command} ya messages forward 'msg:email/me%40example.com/thread-1/1001' --to bob@example.com "FYI"`,
          ],
        }),
      ),
    ),
    "mail_send",
    mailSend,
  )
    .summary("forward an email, attached whole, over SMTP")
    .description(
      "forward a stored email to other people: the original goes as an attached message with its own attachments, " +
        "Fwd: before its subject. Mail to anyone but you asks first (permissions.messages.send.others)",
    )
    .argument("<message>", "the msg:email/… reference search messages shows")
    .argument("[text]", "a few words above the forwarded message")
    .option("--subject <text>", "the subject instead of the original's with Fwd:")
    .action(forwardAction)
