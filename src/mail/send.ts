import { CliError, realSleep } from "@wirecat/cli-base"
import { type MailSyncResult, storedMailRules, syncMail } from "@wirecat/cli-core/mail"
import {
  DEFAULT_PACE,
  type GuardRequest,
  guardedWrite,
  newOperationId,
  Pacer,
  pacePathFor,
  type SendGuard,
  type SendKind,
} from "@wirecat/cli-core/sends"
import { SEND_OTHERS_KEY } from "../config.js"
import { IDENTITY } from "../identity.js"
import type { MailBackend, Submitted } from "./backend.js"
import { build, type Draft, type Person } from "./compose.js"
import { locate, type Mailbox, selectIds } from "./organise.js"

type Attempt = Parameters<typeof guardedWrite>[1]

/** What a send needs of the opened profile, beside the draft. */
export interface Sending {
  mailbox: Mailbox
  backend: MailBackend
  guard: SendGuard
  profile: string
  env: NodeJS.ProcessEnv
  owner: ReadonlySet<string>
  /** The provider files what SMTP carried into Sent itself (Gmail). */
  savesSent: boolean
  /** The folders a plain `sync` reads, so the sent message is stored as the next sync would store it. */
  syncFolders: () => Promise<{ folders: string[]; mode: "imap" | "gmail" }>
  warn: (message: string) => void
  /**
   * Run by an agent over MCP, where `ask` would go ahead (WC-MCP-7), and the owner has not set
   * `messages.send.others` in the config: mail to others is then refused, as `readonly` would.
   */
  agentWithoutOthers?: boolean
}

export const everyone = (draft: Pick<Draft, "to" | "cc" | "bcc">): Person[] => {
  const seen = new Set<string>()
  return [...draft.to, ...draft.cc, ...draft.bcc].filter(({ address }) => !seen.has(address) && !!seen.add(address))
}

export const othersOf = (draft: Pick<Draft, "to" | "cc" | "bcc">, owner: ReadonlySet<string>): Person[] =>
  everyone(draft).filter(({ address }) => !owner.has(address))

/** The original of a reply or forward on the server: where it is, and its bytes. */
export const fetchOriginal = async (mailbox: Mailbox, backend: MailBackend, ref: string, profile: string) => {
  const { ids } = await selectIds(mailbox, { refs: [ref] })
  const { located } = await locate(mailbox, ids)
  const place = located[0]
  const item = place?.items[0]
  if (!place || !item)
    throw new CliError(
      "not_found",
      `${ref} is not on the server any more, or not where the store last saw it; run \`${IDENTITY.command} ${profile} sync\``,
    )
  const [raw] = await backend.fetchRaw([{ uid: String(item.uid), folder: place.folder, receivedAt: "" }])
  if (!(raw instanceof Uint8Array)) throw new CliError("provider_error", "the server did not give the original message")
  return { folder: place.folder, validity: place.validity, uid: item.uid, raw }
}

const sentFolder = async (mailbox: Mailbox) => (await mailbox.folders()).find(({ role }) => role === "sent")?.path

/** Whether Sent already holds this Message-ID: a send the server answered too late, or Gmail's own copy. */
const inSent = async (mailbox: Mailbox, messageId: string): Promise<{ folder?: string; found: boolean }> => {
  const folder = await sentFolder(mailbox)
  if (!folder) return { found: false }
  const { uids } = await mailbox.writes.locate(folder, { messageIds: [messageId] })
  return { folder, found: uids.size > 0 }
}

export type SentCopy = "server" | "appended" | "found" | "no-sent-folder" | "failed"

/**
 * After SMTP: a server that files sent mail itself is left alone; otherwise the copy goes to Sent unless Sent already
 * has it, so a server that also files it keeps one copy.
 */
const fileCopy = async (sending: Sending, messageId: string, copy: Uint8Array): Promise<SentCopy> => {
  if (sending.savesSent) return "server"
  try {
    const { folder, found } = await inSent(sending.mailbox, messageId)
    if (!folder) return "no-sent-folder"
    if (found) return "found"
    if (!sending.mailbox.writes.append) return "failed"
    await sending.mailbox.writes.append(folder, copy, ["\\Seen"])
    return "appended"
  } catch {
    sending.warn("the message was sent, but its copy could not be put in Sent")
    return "failed"
  }
}

const SYNC_WINDOW_MS = 10 * 60 * 1000

/** The sent copy into the store the way `sync` reads it, so it has the server's id and no second row ever appears. */
const storeSent = async (sending: Sending): Promise<boolean> => {
  try {
    const { folders, mode } = await sending.syncFolders()
    const address = sending.mailbox.key.account
    const rules = await storedMailRules(sending.mailbox.store, { address })
    const report: MailSyncResult = await syncMail(sending.backend, sending.mailbox.store, {
      account: { address, mode, folders, rules },
      since: new Date(Date.now() - SYNC_WINDOW_MS),
    })
    return report.saved + report.alreadyStored > 0
  } catch {
    sending.warn(`the message was sent; \`${IDENTITY.command} ${sending.profile} sync\` stores it`)
    return false
  }
}

/** `\Answered` on a replied message, `$Forwarded` on a forwarded one, as mail clients mark them; best effort. */
const markOriginal = async (
  sending: Sending,
  original: { folder: string; validity: string; uid: number },
  flag: string,
) => {
  const request: Attempt = {
    chatId: null,
    kind: "account",
    action: "message-flag",
    key: "messages.update",
    count: 1,
    operationId: newOperationId(),
  }
  try {
    await guardedWrite(sending.guard, request, () =>
      sending.mailbox.writes.flag(original.folder, original.validity, [original.uid], { add: [flag] }),
    )
    return true
  } catch {
    sending.warn(`the message was sent; the original was not marked ${flag}`)
    return false
  }
}

export interface Outgoing {
  draft: Draft
  kind: Extract<SendKind, "message" | "forward">
  key: "messages.send" | "messages.forward"
  operationId: string
  /** Set by the owner's `--operation-id`: a retry, so Sent is checked before anything goes again. */
  retry: boolean
  original?: { folder: string; validity: string; uid: number; flag: string }
}

export interface Sent {
  operationId: string
  messageId: string
  alreadySent: boolean
  accepted: number
  rejected: number
  sentCopy: SentCopy | null
  stored: boolean
  markedOriginal: boolean | null
}

/**
 * Asks and checks the guard, waits for the pace, submits once, then files the copy, marks the original and stores the
 * message. Everything after the submission is best effort: the message is with people, and an error there would invite
 * the owner to send it again.
 */
export const sendOut = async (sending: Sending, outgoing: Outgoing): Promise<Sent> => {
  const { draft, operationId } = outgoing
  const recipients = everyone(draft)
  const attempt: Attempt = {
    chatId: null,
    kind: outgoing.kind,
    key: outgoing.key,
    count: recipients.length,
    operationId,
    sendId: operationId,
    length: draft.text.length,
    ...(draft.files.length || draft.message
      ? {
          attachments: [
            ...draft.files.map(({ bytes }) => ({ kind: "file" as const, bytes })),
            ...(draft.message ? [{ kind: "file" as const, bytes: draft.message.raw.byteLength }] : []),
          ],
        }
      : {}),
  }
  if (othersOf(draft, sending.owner).length > 0) {
    // One more key for mail that reaches anyone but the owner: the owner can open self-sends and still be asked here.
    const probe: GuardRequest = { chatId: null, kind: "read", key: SEND_OTHERS_KEY }
    try {
      if (sending.agentWithoutOthers)
        throw new CliError(
          "permission_error",
          `over MCP, profile ${sending.profile} mails only its owner: permissions.${SEND_OTHERS_KEY} is readonly for an ` +
            "agent until the owner sets it in the config; to let an agent mail others: " +
            `${IDENTITY.command} ${sending.profile} config set permissions.${SEND_OTHERS_KEY} allow`,
          { permission: SEND_OTHERS_KEY },
        )
      await sending.guard.ask?.(probe)
      sending.guard.check(probe, { reserve: false })
    } catch (error) {
      sending.guard.record({ ...attempt, outcome: "refused", errorCode: (error as CliError).code ?? "unknown" })
      throw error
    }
  }
  if (outgoing.retry && (await inSent(sending.mailbox, draft.messageId)).found)
    return {
      operationId,
      messageId: draft.messageId,
      alreadySent: true,
      accepted: 0,
      rejected: 0,
      sentCopy: "found",
      stored: false,
      markedOriginal: null,
    }
  const submit = sending.backend.submit
  if (!submit)
    throw new CliError(
      "configuration_error",
      `profile ${sending.profile} names no submission server; set smtp_host, smtp_port and smtp_security with ` +
        `\`${IDENTITY.command} ${sending.profile} config set\``,
      { sent: false },
    )
  const { raw, copy } = await build(draft)
  const pacer = new Pacer(pacePathFor(IDENTITY, sending.profile, sending.env), DEFAULT_PACE)
  const submitted: Submitted = await guardedWrite(
    sending.guard,
    attempt,
    () => submit.send({ from: draft.from.address, recipients: recipients.map(({ address }) => address), raw }),
    () => ({}),
    async () => {
      const at = await pacer.reserve()
      if (at > Date.now()) await realSleep(at - Date.now())
    },
  )
  const sentCopy = await fileCopy(sending, draft.messageId, copy)
  const markedOriginal = outgoing.original
    ? await markOriginal(sending, outgoing.original, outgoing.original.flag)
    : null
  const stored = await storeSent(sending)
  return {
    operationId,
    messageId: draft.messageId,
    alreadySent: false,
    accepted: submitted.accepted.length,
    rejected: submitted.rejected.length,
    sentCopy,
    stored,
    markedOriginal,
  }
}
