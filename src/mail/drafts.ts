import { CliError } from "@wirecat/cli-base"
import { parseMail } from "@wirecat/cli-core/mail"
import type { Organise } from "../providers.js"
import type { FolderInfo, MailBackend } from "./backend.js"
import { type Draft as Outgoing, type Person, peopleOf } from "./compose.js"

/** `\Seen` too: a draft is the owner's own text, and a mail app shows an unseen one as new mail. */
export const DRAFT_FLAGS = ["\\Draft", "\\Seen"] as const

export const draftsFolderOf = (folders: readonly FolderInfo[], organise: Organise): string => {
  const found =
    folders.find(({ role }) => role === "drafts") ?? folders.find(({ path }) => organise.drafts.includes(path))
  if (!found)
    throw new CliError(
      "provider_unavailable",
      "the mailbox has no Drafts folder this tool can find; folders list shows the folders",
      { reason: "mail.no-drafts" },
    )
  return found.path
}

/** A draft is named by its Message-ID, which stays the same across its versions; the angle brackets are optional. */
export const draftIdOf = (given: string): string => {
  const bare = given.trim().replace(/^<|>$/g, "")
  if (!/^[^\s<>]+@[^\s<>]+$/.test(bare))
    throw new CliError("validation_error", `"${given}" is no draft id — drafts list shows them`, { param: "draft" })
  return `<${bare}>`
}

export interface Draft {
  id: string
  uid: number
  subject: string
  from: string | null
  to: string[]
  cc: string[]
  bcc: string[]
  date: string | null
  in_reply_to: string | null
  attachments: { name: string; mime: string | null }[]
  text: string
}

const dateOf = (raw: Uint8Array) => {
  const head =
    Buffer.from(raw)
      .toString("latin1")
      .split(/\r?\n\r?\n/)[0] ?? ""
  const value = /^Date:[ \t]*(.+)$/im.exec(head)?.[1]
  const at = value ? Date.parse(value) : Number.NaN
  return Number.isNaN(at) ? null : new Date(at).toISOString()
}

const shown = (people: { email: string; name: string | null }[]) =>
  people.map(({ email, name }) => (name ? `${name} <${email}>` : email))

/** A draft as the answer shows it, and what its next version carries over: thread, Bcc and attachments. */
export interface ReadDraft {
  draft: Draft
  references: string[]
  parts: NonNullable<Outgoing["parts"]>
}

export const readDraft = async (raw: Uint8Array, uid: number): Promise<ReadDraft> => {
  const parsed = await parseMail(raw, undefined, Number.POSITIVE_INFINITY)
  const head =
    Buffer.from(raw)
      .toString("latin1")
      .split(/\r?\n\r?\n/)[0] ?? ""
  return {
    draft: {
      id: (parsed.messageId ?? "").replace(/^<|>$/g, ""),
      uid,
      subject: parsed.subject ?? "",
      from: parsed.from ? (shown([parsed.from])[0] as string) : null,
      to: shown(parsed.to),
      cc: shown(parsed.cc),
      bcc: shown(parsed.bcc),
      date: dateOf(raw),
      in_reply_to: /^In-Reply-To:[ \t]*(<[^<>\s]+>)/im.exec(head)?.[1] ?? null,
      attachments: parsed.attachments.map(({ name, mime }) => ({ name, mime })),
      text: parsed.text,
    },
    references: parsed.references,
    parts: parsed.attachments.flatMap(({ name, mime, bytes }) => (bytes ? [{ name, mime, bytes }] : [])),
  }
}

type Reads = Pick<MailBackend, "search" | "fetchRaw">

const rawOf = async (backend: Reads, folder: string, uids: number[]) => {
  const read = await backend.fetchRaw(uids.map((uid) => ({ uid: String(uid), receivedAt: "", folder })))
  return read.map((one) => {
    if (one instanceof Error) throw one
    return one
  })
}

/** The newest drafts first, at most `limit`; read from the server, since the store holds Drafts only if it syncs it. */
export const listDrafts = async (backend: Reads, folder: string, limit: number) => {
  if (!backend.search) throw new CliError("provider_unavailable", "this mailbox cannot list a folder")
  const { uids } = await backend.search(new Date(0), folder)
  const newest = uids
    .map(Number)
    .sort((a, b) => b - a)
    .slice(0, limit)
  const raws = newest.length ? await rawOf(backend, folder, newest) : []
  const drafts = await Promise.all(raws.map((raw, at) => readDraft(raw, newest[at] as number)))
  return { items: drafts.map(({ draft }) => draft), more: uids.length > limit }
}

/** The draft with this Message-ID now: its UID, the folder's UIDVALIDITY and what it holds. */
export const findDraft = async (backend: Pick<MailBackend, "writes" | "fetchRaw">, folder: string, id: string) => {
  const writes = backend.writes
  if (!writes) throw new CliError("provider_unavailable", "this mailbox cannot be changed from here")
  const { validity, uids } = await writes.locate(folder, { messageIds: [id] })
  const uid = uids.get(id)
  if (uid === undefined)
    throw new CliError("not_found", `no draft ${id.replace(/^<|>$/g, "")} in ${folder}; drafts list shows them`, {
      reason: "mail.draft-unknown",
    })
  const [raw] = await rawOf(backend, folder, [uid])
  return { uid, validity, read: await readDraft(raw as Uint8Array, uid) }
}

export interface Changes {
  to?: Person[]
  cc?: Person[]
  bcc?: Person[]
  subject?: string
  text?: string
}

/** The next version of a draft: each given field replaces the old one; the rest, its thread and its id stay. */
export const nextVersion = ({ draft, references, parts }: ReadDraft, given: Changes, owner: string): Outgoing => {
  const people = (list: string[], flag: string) => (list.length ? peopleOf(list, flag) : [])
  return {
    from: peopleOf([draft.from ?? owner], "from")[0] as Person,
    to: given.to ?? people(draft.to, "--to"),
    cc: given.cc ?? people(draft.cc, "--cc"),
    bcc: given.bcc ?? people(draft.bcc, "--bcc"),
    subject: given.subject ?? draft.subject,
    text: given.text ?? draft.text,
    messageId: `<${draft.id}>`,
    date: new Date(),
    ...(draft.in_reply_to ? { inReplyTo: draft.in_reply_to } : {}),
    ...(references.length ? { references } : {}),
    files: [],
    parts,
  }
}
