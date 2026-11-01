import {
  decodedLabelName,
  headersOf,
  type Listed,
  HEADER_FIELDS as MAIL_HEADER_FIELDS,
  mailIds,
  type Quick,
} from "@wirecat/cli-core/mail"
import type { FetchMessageObject, ListResponse } from "imapflow"

/** cli-core's fields for the owner's rules and the probe, and the two that tie a reply to its thread. */
export const HEADER_FIELDS = [...MAIL_HEADER_FIELDS.split(" "), "IN-REPLY-TO", "REFERENCES"]

const headTextOf = (raw: Uint8Array): string => {
  const bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
  const end = [bytes.indexOf("\r\n\r\n"), bytes.indexOf("\n\n")]
    .filter((at) => at !== -1)
    .reduce((first, at) => Math.min(first, at), bytes.length)
  return bytes.subarray(0, end).toString("utf8")
}

/**
 * As memo names them, so the store's `label:Inbox` mailboxes keep matching; a flagged message is Starred anywhere.
 * imapflow has decoded them already.
 */
const labelsOf = (raw: Set<string> | undefined, flagged: boolean): string[] => {
  const names = new Set([...(raw ?? [])].map(decodedLabelName))
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

/** The ids of a message read as bytes, worked out as `listedOf` works them out from a listing. */
export const rawIdsOf = (raw: Uint8Array, folder: string, validity: string, uid: string) =>
  mailIds({ head: headTextOf(raw), folder, validity, uid })

/**
 * `gmail`: the connection is Gmail's, so imapflow's emailId and threadId are X-GM-MSGID and X-GM-THRID, which stored
 * Gmail mail is keyed on. Anywhere else the Message-ID is the id, as memo makes it.
 */
export const listedOf = (message: FetchMessageObject, folder: string, validity: string, gmail: boolean): Listed => {
  const head = message.headers ? message.headers.toString("utf8") : ""
  const ids =
    gmail && message.emailId && message.threadId
      ? { messageId: String(message.emailId), threadId: String(message.threadId) }
      : mailIds({ messageId: message.envelope?.messageId, head, folder, validity, uid: String(message.uid) })
  return { ...quickOf(message, folder), ...ids, headers: headersOf(head) }
}

export const roleOf = (entry: ListResponse): string | null => {
  if (entry.path.toUpperCase() === "INBOX") return "inbox"
  return entry.specialUse ? entry.specialUse.replace(/^\\/, "").toLowerCase() : null
}
