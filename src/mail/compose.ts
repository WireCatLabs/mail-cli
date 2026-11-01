import { CliError } from "@wirecat/cli-base"
import { htmlToText, looksLikeHtml } from "@wirecat/cli-core/mail"
import addressparser from "nodemailer/lib/addressparser"
import MailComposer from "nodemailer/lib/mail-composer"
import PostalMime from "postal-mime"

const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/u

export interface Person {
  address: string
  name?: string
}

/** `ann@example.com`, `Ann <ann@example.com>` or several split by commas; each address checked and lower-cased. */
export const peopleOf = (given: readonly string[], flag: string): Person[] =>
  given.flatMap((one) =>
    addressparser(one, { flatten: true }).map(({ name, address }) => {
      const clean = address.trim().toLowerCase()
      if (!EMAIL.test(clean))
        throw new CliError("validation_error", `${flag} takes email addresses; ${JSON.stringify(one)} holds none`, {
          param: flag.replace(/^--/, ""),
        })
      return { address: clean, ...(name.trim() ? { name: name.trim() } : {}) }
    }),
  )

const unique = (people: readonly Person[], without: ReadonlySet<string> = new Set()): Person[] => {
  const seen = new Set(without)
  return people.filter(({ address }) => !seen.has(address) && seen.add(address) !== undefined)
}

/** The message a reply or forward is built from, read from its raw bytes on the server. */
export interface Original {
  messageId?: string
  references: string[]
  subject: string
  date?: string
  from?: Person
  replyTo: Person[]
  to: Person[]
  cc: Person[]
  text: string
}

const personOf = (address: { address?: string; name?: string } | undefined): Person | undefined =>
  address?.address
    ? { address: address.address.toLowerCase(), ...(address.name ? { name: address.name } : {}) }
    : undefined

const peopleIn = (list: readonly { address?: string; name?: string; group?: unknown[] }[] | undefined): Person[] =>
  (list ?? [])
    .flatMap((entry) => (Array.isArray(entry.group) ? (entry.group as typeof list & object) : [entry]))
    .flatMap((entry) => {
      const person = personOf(entry)
      return person ? [person] : []
    })

const ids = (text: string | undefined): string[] => text?.match(/<[^<>\s]+>/g) ?? []

export const originalOf = async (raw: Uint8Array): Promise<Original> => {
  let email: Awaited<ReturnType<typeof PostalMime.parse>>
  try {
    email = await PostalMime.parse(raw)
  } catch {
    throw new CliError("invalid_response", "the original message on the server cannot be read")
  }
  const plain = email.text?.trim() ?? ""
  const from = personOf(email.from)
  return {
    ...(email.messageId ? { messageId: ids(email.messageId)[0] ?? email.messageId } : {}),
    references: ids(email.references),
    subject: email.subject ?? "",
    ...(email.date ? { date: email.date } : {}),
    ...(from ? { from } : {}),
    replyTo: peopleIn(email.replyTo),
    to: peopleIn(email.to),
    cc: peopleIn(email.cc),
    text: plain && !looksLikeHtml(plain) ? plain : htmlToText(email.html ?? plain),
  }
}

/**
 * Who a reply goes to: Reply-To, else the sender. Answering one's own message goes to its recipients instead.
 * `all` adds the other recipients; the owner never receives a copy of their own reply.
 */
export const replyPeople = (original: Original, owner: ReadonlySet<string>, all: boolean): Person[] => {
  const mine = original.from !== undefined && owner.has(original.from.address)
  const first = mine ? original.to : original.replyTo.length ? original.replyTo : original.from ? [original.from] : []
  return unique([...first, ...(all ? [...original.to, ...original.cc] : [])], owner)
}

/** The rest after a reply's `to`, for reply-all's Cc. */
export const replyCopies = (original: Original, owner: ReadonlySet<string>, to: readonly Person[]): Person[] =>
  unique([...original.to, ...original.cc], new Set([...owner, ...to.map(({ address }) => address)]))

const prefixed = (subject: string, prefix: string, already: RegExp) =>
  already.test(subject.trim()) ? subject.trim() : `${prefix} ${subject.trim()}`.trim()

export const replySubject = (subject: string) => prefixed(subject, "Re:", /^(re|ha|aw|sv)\s*:/iu)

export const forwardSubject = (subject: string) => prefixed(subject, "Fwd:", /^(fwd?|fw)\s*:/iu)

/** RFC 5322 §3.6.4: the parent's References and its Message-ID; only the newest are kept on a long thread. */
export const referencesOf = (original: Original): string[] =>
  [...original.references, ...(original.messageId ? [original.messageId] : [])].slice(-20)

const shown = (person: Person | undefined) =>
  person === undefined ? "someone" : person.name ? `${person.name} <${person.address}>` : person.address

/** The text above the quote and every line of the original behind `> `, as plain-text mail clients quote. */
export const quoted = (text: string, original: Original): string => {
  const when = original.date ? `On ${original.date}, ` : ""
  const lines = original.text.split("\n").map((line) => (line.startsWith(">") ? `>${line}` : `> ${line}`))
  return `${text.trimEnd()}\n\n${when}${shown(original.from)} wrote:\n${lines.join("\n")}\n`
}

export interface Draft {
  from: Person
  to: Person[]
  cc: Person[]
  bcc: Person[]
  subject: string
  text: string
  messageId: string
  date: Date
  inReplyTo?: string
  references?: string[]
  files: { name: string; path: string; bytes: number }[]
  /** Attachments already in memory: those of a draft that is being replaced. */
  parts?: { name: string; mime: string | null; bytes: Uint8Array }[]
  /** A forwarded message, attached whole as `message/rfc822`. */
  message?: { name: string; raw: Uint8Array }
}

const header = (person: Person) => (person.name ? { name: person.name, address: person.address } : person.address)

/**
 * The bytes that go out, without a Bcc line, and the copy for Sent, which keeps it so the owner sees who had one.
 * Both carry the same Message-ID, so the copy is found by it.
 */
export const build = async (draft: Draft): Promise<{ raw: Uint8Array; copy: Uint8Array }> => {
  const options = {
    from: header(draft.from),
    to: draft.to.map(header),
    ...(draft.cc.length ? { cc: draft.cc.map(header) } : {}),
    ...(draft.bcc.length ? { bcc: draft.bcc.map(header) } : {}),
    subject: draft.subject,
    text: draft.text,
    messageId: draft.messageId,
    date: draft.date,
    ...(draft.inReplyTo ? { inReplyTo: draft.inReplyTo } : {}),
    ...(draft.references?.length ? { references: draft.references } : {}),
    attachments: [
      ...draft.files.map(({ name, path }) => ({ filename: name, path })),
      ...(draft.parts ?? []).map(({ name, mime, bytes }) => ({
        filename: name,
        content: Buffer.from(bytes),
        ...(mime ? { contentType: mime } : {}),
      })),
      ...(draft.message
        ? [
            {
              filename: draft.message.name,
              content: Buffer.from(draft.message.raw),
              contentType: "message/rfc822",
              contentDisposition: "attachment",
            },
          ]
        : []),
    ],
    disableUrlAccess: true,
    newline: "\r\n",
  }
  const sent = new MailComposer(options).compile()
  const copy = new MailComposer(options).compile()
  copy.keepBcc = true
  return { raw: new Uint8Array(await sent.build()), copy: new Uint8Array(await copy.build()) }
}

/** `<operation-id@domain>`: the same id on a retry with `--operation-id`, so Sent can tell whether it already went. */
export const messageIdFor = (operationId: string, from: string): string =>
  `<${operationId.replace(/[^\w.-]/g, "")}@${from.split("@")[1] ?? "localhost"}>`

/** The text says something is attached and nothing is: the mistake NeoMutt warns about. */
export const forgotAttachment = (text: string, attached: boolean): boolean =>
  !attached && /\battach(ed|ment|ing)?\b|влож(ени|ил|ен)|прилага|прикреп/iu.test(text)
