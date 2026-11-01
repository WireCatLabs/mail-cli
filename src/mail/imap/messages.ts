import { createHash } from "node:crypto"
import type { Listed, MailHeaders, Quick } from "@wirecat/cli-core/mail"
import type { FetchMessageObject, ListResponse } from "imapflow"

/** The header fields a listing asks for, so a mailing list is told apart from a person's mail. */
export const HEADER_FIELDS = ["list-id", "list-unsubscribe", "precedence"]

const digest = (id: string) => `imap:${createHash("sha256").update(id).digest("hex")}`

const headersOf = (message: FetchMessageObject): MailHeaders => {
  const from = message.envelope?.from?.[0]
  const raw = message.headers ? message.headers.toString("utf8") : ""
  const field = (name: string) =>
    new RegExp(`^${name}:[ \\t]*(.*)$`, "im").exec(raw.replace(/\r?\n[ \t]+/g, " "))?.[1]?.trim()
  const listId = field("list-id")
  const bulk =
    listId !== undefined ||
    field("list-unsubscribe") !== undefined ||
    /^(bulk|list|junk)$/i.test(field("precedence") ?? "")
  return {
    ...(from?.address ? { from: from.address.toLowerCase() } : {}),
    ...(from?.name ? { fromName: from.name } : {}),
    ...(message.envelope?.subject ? { subject: message.envelope.subject } : {}),
    to: [...(message.envelope?.to ?? []), ...(message.envelope?.cc ?? [])].flatMap((a) =>
      a.address ? [a.address.toLowerCase()] : [],
    ),
    ...(listId ? { listId } : {}),
    bulk,
  }
}

export const quickOf = (message: FetchMessageObject, folder: string): Quick => {
  const flags = message.flags ?? new Set<string>()
  const received = message.internalDate instanceof Date ? message.internalDate : new Date(message.internalDate ?? 0)
  return {
    uid: String(message.uid),
    receivedAt: received.toISOString(),
    folder,
    ...(message.size === undefined ? {} : { size: message.size }),
    seen: flags.has("\\Seen"),
    flagged: flags.has("\\Flagged"),
    labels: message.labels ? [...message.labels] : flags.has("\\Flagged") ? ["Starred"] : [],
  }
}

/** Without a stable id the Message-ID is the identity; without that, the UID, which means nothing without UIDVALIDITY. */
export const idsOf = (messageId: string | undefined, folder: string, validity: string, uid: string) => {
  const identity = messageId ?? `uid:${folder}:${validity}:${uid}`
  return { messageId: digest(identity), threadId: digest(identity) }
}

export const listedOf = (message: FetchMessageObject, folder: string, validity: string): Listed => {
  const ids = idsOf(message.envelope?.messageId, folder, validity, String(message.uid))
  return {
    ...quickOf(message, folder),
    ...(message.emailId ? { messageId: String(message.emailId) } : { messageId: ids.messageId }),
    threadId: message.threadId ? String(message.threadId) : ids.threadId,
    headers: headersOf(message),
  }
}

/**
 * The Message-ID as the server's ENVELOPE gives it (imapflow trims the value of the first header), so the id of a
 * message read as bytes is the id `list` gives it.
 */
export const messageIdOf = (raw: Uint8Array): string | undefined => {
  const bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
  const end = [bytes.indexOf("\r\n\r\n"), bytes.indexOf("\n\n")]
    .filter((at) => at !== -1)
    .reduce((first, at) => Math.min(first, at), bytes.length)
  const head = bytes.subarray(0, end).toString("utf8")
  return /^message-id:[ \t]*(.*)$/im.exec(head.replace(/\r?\n[ \t]+/g, " "))?.[1]?.trim() || undefined
}

export const roleOf = (entry: ListResponse): string | null => {
  if (entry.path.toUpperCase() === "INBOX") return "inbox"
  return entry.specialUse ? entry.specialUse.replace(/^\\/, "").toLowerCase() : null
}
