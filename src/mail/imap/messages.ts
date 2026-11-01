import { createHash } from "node:crypto"
import {
  headersOf,
  type Listed,
  labelName,
  HEADER_FIELDS as MAIL_HEADER_FIELDS,
  type Quick,
} from "@wirecat/cli-core/mail"
import type { FetchMessageObject, ListResponse } from "imapflow"

/** cli-core's fields for the owner's rules and the probe, and the two that tie a reply to its thread. */
export const HEADER_FIELDS = [...MAIL_HEADER_FIELDS.split(" "), "IN-REPLY-TO", "REFERENCES"]

const digest = (id: string) => `imap:${createHash("sha256").update(id).digest("hex")}`

const headTextOf = (raw: Uint8Array): string => {
  const bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
  const end = [bytes.indexOf("\r\n\r\n"), bytes.indexOf("\n\n")]
    .filter((at) => at !== -1)
    .reduce((first, at) => Math.min(first, at), bytes.length)
  return bytes.subarray(0, end).toString("utf8")
}

const fieldOf = (head: string, name: string): string | undefined =>
  new RegExp(`^${name}:[ \\t]*(.*)$`, "im").exec(head.replace(/\r?\n[ \t]+/g, " "))?.[1]?.trim()

/**
 * The first Message-ID of References is the thread's first email (RFC 5322 §3.6.4); a reply with only In-Reply-To
 * names its parent. A server without thread ids (Yandex, Mail.ru) then still keeps a conversation together.
 */
const threadRootOf = (head: string): string | undefined =>
  /<[^<>\s]+>/.exec(fieldOf(head, "references") ?? "")?.[0] ??
  /<[^<>\s]+>/.exec(fieldOf(head, "in-reply-to") ?? "")?.[0]

/** As memo names them, so the store's `label:Inbox` mailboxes keep matching; a flagged message is Starred anywhere. */
const labelsOf = (raw: Set<string> | undefined, flagged: boolean): string[] => {
  const names = new Set([...(raw ?? [])].map(labelName))
  if (flagged) names.add("Starred")
  return [...names].sort()
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
    labels: labelsOf(message.labels, flags.has("\\Flagged")),
  }
}

/** Without a stable id the Message-ID is the identity; without that, the UID, which means nothing without UIDVALIDITY. */
export const idsOf = (messageId: string | undefined, folder: string, validity: string, uid: string, root?: string) => {
  const identity = messageId ?? `uid:${folder}:${validity}:${uid}`
  return { messageId: digest(identity), threadId: digest(root ?? identity) }
}

/** The ids of a message read as bytes, worked out as `listedOf` works them out from a listing. */
export const rawIdsOf = (raw: Uint8Array, folder: string, validity: string, uid: string) => {
  const head = headTextOf(raw)
  return idsOf(fieldOf(head, "message-id") || undefined, folder, validity, uid, threadRootOf(head))
}

export const listedOf = (message: FetchMessageObject, folder: string, validity: string): Listed => {
  const head = message.headers ? message.headers.toString("utf8") : ""
  const ids = idsOf(message.envelope?.messageId, folder, validity, String(message.uid), threadRootOf(head))
  return {
    ...quickOf(message, folder),
    // Gmail's X-GM-MSGID and X-GM-THRID, or OBJECTID's: stored Gmail mail is keyed on them.
    ...(message.emailId ? { messageId: String(message.emailId) } : { messageId: ids.messageId }),
    threadId: message.threadId ? String(message.threadId) : ids.threadId,
    headers: headersOf(head),
  }
}

export const roleOf = (entry: ListResponse): string | null => {
  if (entry.path.toUpperCase() === "INBOX") return "inbox"
  return entry.specialUse ? entry.specialUse.replace(/^\\/, "").toLowerCase() : null
}
