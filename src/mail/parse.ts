import PostalMime, { type Address } from "postal-mime"

export interface Person {
  address: string
  name: string | null
}

export interface ParsedMail {
  messageId: string | null
  subject: string | null
  from: Person | null
  to: Person[]
  cc: Person[]
  sentAt: number | null
  inReplyTo: string | null
  references: string[]
  text: string
}

// A guard against a pasted log, not a design limit.
export const MAX_BODY_CHARS = 1_000_000

const people = (list: Address[] | undefined): Person[] =>
  (list ?? [])
    .flatMap((entry) => entry.group ?? [entry])
    .flatMap(({ address, name }) => (address ? [{ address: address.toLowerCase(), name: name || null }] : []))

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" }

// Mail without a text part is read as its HTML with the tags removed; nothing in it is rendered or followed.
const htmlText = (html: string): string =>
  html
    .replace(/<!--[\s\S]*?(-->|$)/g, "")
    .replace(/<(script|style)[\s\S]*?(<\/\1>|$)/gi, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(nbsp|amp|lt|gt|quot|#39);/g, (_, name: string) => ENTITIES[name] ?? "")
    .replace(/[ \t]+/g, " ")

export const parseMail = async (raw: Uint8Array): Promise<ParsedMail> => {
  const mail = await PostalMime.parse(raw, { attachmentEncoding: "arraybuffer" })
  const sent = mail.date ? Date.parse(mail.date) : Number.NaN
  const text = (mail.text ?? (mail.html ? htmlText(mail.html) : "")).slice(0, MAX_BODY_CHARS)
  return {
    messageId: mail.messageId ?? null,
    subject: mail.subject ?? null,
    from: people(mail.from ? [mail.from] : undefined)[0] ?? null,
    to: people(mail.to),
    cc: people(mail.cc),
    sentAt: Number.isNaN(sent) ? null : sent,
    inReplyTo: mail.inReplyTo ?? null,
    references: mail.references?.match(/<[^>]+>/g) ?? [],
    text,
  }
}
