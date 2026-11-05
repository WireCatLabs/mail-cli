import { CliError } from "@wirecat/cli-base"
import { parseReference } from "@wirecat/cli-core"
import { searchMail } from "@wirecat/cli-core/mail"
import type { ChangedItem } from "./changes.js"
import { FILTER_LIMIT, type Mailbox } from "./organise.js"

const PAGE = 100

/** Stored mail by reference or by the shared query, at most `limit`; `more` says the query matched more. */
export const selectIds = async (
  mailbox: Mailbox,
  { refs = [], filter, limit = FILTER_LIMIT }: { refs?: string[]; filter?: string; limit?: number },
): Promise<{ ids: string[]; more: boolean }> => {
  if (refs.length === 0 && filter === undefined)
    throw new CliError("validation_error", "name the messages", { reason: "mail.no-selection" })
  if (refs.length > 0 && filter !== undefined)
    throw new CliError("validation_error", "give message references or a query, not both", {
      param: "filter",
      reason: "mail.refs-and-filter",
    })
  const ids = new Set<string>()
  for (const ref of refs) {
    const place = parseReference(ref)
    if (place.type !== "message")
      throw new CliError("validation_error", `${ref} names no email — give the msg:email/… reference search shows`)
    if (place.provider !== mailbox.key.provider || place.account !== mailbox.key.account)
      throw new CliError("not_found", `${ref} is not mail of this profile's mailbox ${mailbox.key.account}`)
    ids.add(place.message)
  }
  if (filter === undefined) return { ids: [...ids], more: false }
  let more = false
  for (let offset = 0; ids.size < limit; offset += PAGE) {
    const found = await searchMail(
      mailbox.store,
      mailbox.key,
      { text: filter, limit: PAGE, offset, mailAccount: mailbox.key.account, newest: true },
      { app: mailbox.app },
    )
    for (const hit of found.items) {
      const place = parseReference(hit.locator)
      if (place.type === "message") ids.add(place.message)
    }
    if (!found.hasMore) break
    more = ids.size >= limit
  }
  return { ids: [...ids].slice(0, limit), more: more || ids.size > limit }
}

export interface Located {
  folder: string
  validity: string
  items: ChangedItem[]
}

/** Gmail searches by its own id; the hash of a Message-ID is found through the stored UIDs. */
export const serverId = (id: string) => !id.startsWith("imap:")

/**
 * Where each email is on the server now, folder by folder. `everywhere` keeps every place an email is in (a flag is
 * set on each copy); otherwise only its first, so one email is moved once. Trash counts only when `trash` is given.
 */
export const locate = async (
  mailbox: Mailbox,
  ids: readonly string[],
  { everywhere = false, trash }: { everywhere?: boolean; trash?: string } = {},
): Promise<{ located: Located[]; missing: string[]; deleted: string[]; inTrash: string[] }> => {
  const byFolder = new Map<string, string[]>()
  const missing: string[] = []
  const deleted: string[] = []
  const inTrash: string[] = []
  for (const id of ids) {
    const email = await mailbox.store.mail.email(mailbox.accountId, id)
    if (email === null) {
      missing.push(id)
      continue
    }
    if (email.deletedAt !== null) {
      deleted.push(id)
      continue
    }
    const folders = email.mailboxes.filter(({ kind }) => kind === null).map(({ externalId }) => externalId)
    const usable = folders.filter((folder) => folder !== trash)
    if (usable.length === 0 && folders.length > 0) {
      inTrash.push(id)
      continue
    }
    if (usable.length === 0) {
      missing.push(id)
      continue
    }
    for (const folder of everywhere ? usable : usable.slice(0, 1))
      byFolder.set(folder, [...(byFolder.get(folder) ?? []), id])
  }
  const located: Located[] = []
  const placed = new Set<string>()
  for (const [folder, wanted] of byFolder) {
    const { validity, uids } = await mailbox.writes.locate(folder, { emailIds: wanted.filter(serverId) })
    const stored = wanted.some((id) => !serverId(id))
      ? new Map(
          (await mailbox.store.mail.folderEmails(mailbox.accountId, folder, validity)).map((row) => [
            row.externalId,
            row.uid,
          ]),
        )
      : new Map<string, number>()
    const items = wanted.flatMap((id) => {
      const uid = uids.get(id) ?? stored.get(id)
      return uid === undefined ? [] : [{ id, uid }]
    })
    for (const { id } of items) placed.add(id)
    if (items.length) located.push({ folder, validity, items })
  }
  for (const list of byFolder.values())
    for (const id of list) if (!placed.has(id) && !missing.includes(id)) missing.push(id)
  return { located, missing, deleted, inTrash }
}
