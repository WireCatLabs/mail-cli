import { CliError } from "@wirecat/cli-base"
import { parseReference } from "@wirecat/cli-core"
import type { AppIdentity } from "@wirecat/cli-core/cli"
import { ENVELOPE, labelName, searchMail } from "@wirecat/cli-core/mail"
import { type GuardRequest, guardedWrite, newOperationId, type SendGuard } from "@wirecat/cli-core/sends"
import type { AccountKey, MessageStore } from "@wirecat/cli-core/store"
import type { Organise } from "../providers.js"
import type { FolderInfo, MailWrites, ServerState } from "./backend.js"
import { appendRestore, type ChangedItem, type ChangeLog, type ChangeRun, type StepLine } from "./changes.js"

/** One mailbox as the write commands see it: its stored mail, its server and where its provider differs. */
export interface Mailbox {
  app: AppIdentity
  store: MessageStore
  key: AccountKey
  accountId: number
  writes: MailWrites
  folders: () => Promise<FolderInfo[]>
  organise: Organise
  now: () => number
}

export const FILTER_LIMIT = 500
export const MAX_LIMIT = 5_000
/** More messages than this at once is a bulk change: previewed first and checked as `messages.bulk` too. */
export const BULK = 20
const PAGE = 100

const SYSTEM_FLAGS: Record<string, string> = {
  read: "\\Seen",
  seen: "\\Seen",
  flagged: "\\Flagged",
  starred: "\\Flagged",
  answered: "\\Answered",
  draft: "\\Draft",
}
const KEYWORD = /^\$?[A-Za-z0-9_.-]+$/

/** A flag as the owner types it, `read` or `$Junk`, in IMAP's spelling; `\Deleted` is refused, it is how mail is expunged. */
export const flagOf = (given: string): string => {
  const word = given.trim()
  const system = SYSTEM_FLAGS[word.toLowerCase().replace(/^\\/, "")]
  if (system) return system
  if (/^\\deleted$/i.test(word) || word.toLowerCase() === "deleted")
    throw new CliError(
      "validation_error",
      "\\Deleted is how a server expunges mail; messages delete moves it to Trash",
      {
        param: "add",
      },
    )
  if (!KEYWORD.test(word))
    throw new CliError(
      "validation_error",
      `"${given}" is no flag: give read, flagged, answered, draft, or a keyword of letters, digits and $._-`,
      { param: "add" },
    )
  return word
}

/** Stored mail by reference or by the shared query, at most `limit`; `more` says the query matched more. */
export const selectIds = async (
  mailbox: Mailbox,
  { refs = [], filter, limit = FILTER_LIMIT }: { refs?: string[]; filter?: string; limit?: number },
): Promise<{ ids: string[]; more: boolean }> => {
  if (refs.length === 0 && filter === undefined)
    throw new CliError("validation_error", "name the messages: their msg:email/… references, or --filter <query>")
  if (refs.length > 0 && filter !== undefined)
    throw new CliError("validation_error", "give message references or --filter, not both", { param: "filter" })
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

interface Located {
  folder: string
  validity: string
  items: ChangedItem[]
}

/** Gmail and OBJECTID servers search by their own id; the hash of a Message-ID is found through the stored UIDs. */
const serverId = (id: string) => !id.startsWith("imap:")

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

/** The folder a name or a role names: its path, a role (`archive`, `trash`), then a name in any case. */
export const folderNamed = (folders: readonly FolderInfo[], given: string): FolderInfo | undefined => {
  const word = given.trim()
  return (
    folders.find(({ path }) => path === word) ??
    folders.find(({ role }) => role === word.toLowerCase()) ??
    folders.find(
      ({ path, name }) => path.toLowerCase() === word.toLowerCase() || name.toLowerCase() === word.toLowerCase(),
    )
  )
}

export const trashOf = async (mailbox: Mailbox): Promise<string> => {
  const folders = await mailbox.folders()
  const found =
    folders.find(({ role }) => role === "trash") ?? folders.find(({ path }) => mailbox.organise.trash.includes(path))
  if (!found)
    throw new CliError(
      "provider_unavailable",
      "the mailbox has no Trash folder this tool can find, so nothing is deleted; folders list shows the folders",
      { reason: "mail.no-trash" },
    )
  return found.path
}

const allMailOf = async (mailbox: Mailbox): Promise<string> => {
  const found = (await mailbox.folders()).find(({ role }) => role === "all")
  if (!found)
    throw new CliError("provider_unavailable", "Gmail's All Mail folder is not listed", { reason: "mail.no-all-mail" })
  return found.path
}

/** On Gmail a folder is a label: what a move or copy to `given` adds and takes away, or a real folder to move to. */
type Target = { kind: "folder"; path: string } | { kind: "labels"; add: string[]; remove: string[]; name: string }

export const targetOf = async (mailbox: Mailbox, given: string, copy: boolean): Promise<Target> => {
  const folders = await mailbox.folders()
  const found = folderNamed(folders, given)
  if (found?.role === "trash")
    throw new CliError(
      "validation_error",
      "moving to Trash is a deletion: use messages delete, which messages restore undoes",
      {
        param: "folder",
      },
    )
  if (!mailbox.organise.labels) {
    if (!found)
      throw new CliError("not_found", `no folder "${given}"; folders list shows them, folders create makes one`, {
        param: "folder",
      })
    return { kind: "folder", path: found.path }
  }
  if (found?.role === "junk") return { kind: "folder", path: found.path }
  if (found?.role === "inbox") return { kind: "labels", add: ["\\Inbox"], remove: [], name: "INBOX" }
  if (found?.role === "all" || given.trim().toLowerCase() === "archive") {
    if (copy) throw new CliError("validation_error", "on Gmail, all mail is in All Mail already", { param: "folder" })
    return { kind: "labels", add: [], remove: ["\\Inbox"], name: found?.path ?? "All Mail" }
  }
  if (found?.role) throw new CliError("validation_error", `on Gmail, ${found.path} is not a label to move mail to`)
  const name = found?.path ?? given.trim()
  return { kind: "labels", add: [name], remove: copy ? [] : ["\\Inbox"], name }
}

const storeBox = (folder: string) => ({ externalId: folder, name: folder, kind: null })
const labelBox = (raw: string) => {
  const name = labelName(raw)
  return { externalId: `label:${name}`, name, kind: "label" }
}

/** Runs one step against the server under the guard, recording it before it goes and once it is done. */
export class Changer {
  constructor(
    readonly mailbox: Mailbox,
    readonly guard: SendGuard,
    readonly log: ChangeLog,
    readonly key: string,
    readonly action: "message-flag" | "message-move" | "message-copy" | "message-delete" | "message-restore",
  ) {}

  async step<T>(
    line: Omit<StepLine, "type" | "step">,
    act: () => Promise<T>,
    moved?: (done: T) => { uids: Map<string, number>; validity?: string },
  ): Promise<T> {
    const request: GuardRequest & { operationId: string } = {
      chatId: null,
      kind: "account",
      action: this.action,
      key: this.key,
      count: line.items.length,
      operationId: newOperationId(),
    }
    const step = this.log.begin(line)
    const done = await guardedWrite(this.guard, request, act)
    this.log.done(
      step,
      line.items.map(({ id }) => id),
      moved?.(done),
    )
    return done
  }
}

const statesOf = async (mailbox: Mailbox, { folder, validity, items }: Located) =>
  mailbox.writes.state(
    folder,
    validity,
    items.map(({ uid }) => uid),
  )

const groupBy = <T>(items: T[], keyOf: (item: T) => string) => {
  const groups = new Map<string, T[]>()
  for (const item of items) groups.set(keyOf(item), [...(groups.get(keyOf(item)) ?? []), item])
  return groups
}

const flagChanges = (change: { add: string[]; remove: string[] }) => ({
  ...(change.add.includes("\\Seen") ? { read: true } : change.remove.includes("\\Seen") ? { read: false } : {}),
  ...(change.add.includes("\\Flagged")
    ? { flagged: true }
    : change.remove.includes("\\Flagged")
      ? { flagged: false }
      : {}),
})

const SETTABLE = (flag: string) => flag !== "\\Recent" && flag !== "\\Deleted"

/**
 * Adds and removes flags, or with `replace` makes `add` each message's whole set. On Gmail the flags of All Mail are
 * the message's own. The store takes read and flagged once the server said yes.
 */
export const changeFlags = async (
  changer: Changer,
  located: Located[],
  change: { add: string[]; remove: string[]; replace?: boolean },
): Promise<string[]> => {
  const { mailbox } = changer
  const changed: string[] = []
  for (const place of located) {
    const states = await statesOf(mailbox, place)
    const items = place.items.flatMap((item) => {
      const state = states.get(item.uid)
      if (!state) return []
      const now = state.flags.filter(SETTABLE)
      const add = change.add.filter((flag) => !now.includes(flag))
      const remove = change.replace
        ? now.filter((flag) => !change.add.includes(flag))
        : change.remove.filter((flag) => now.includes(flag))
      return add.length || remove.length
        ? [{ item: { ...item, had: now.filter((f) => remove.includes(f)) }, add, remove }]
        : []
    })
    for (const group of groupBy(items, ({ add, remove }) => JSON.stringify([add, remove])).values()) {
      const { add, remove } = group[0] as (typeof items)[number]
      const line = {
        op: "flag" as const,
        folder: place.folder,
        validity: place.validity,
        change: { add, remove },
        items: group.map(({ item }) => item),
      }
      await changer.step(line, () =>
        mailbox.writes.flag(
          place.folder,
          place.validity,
          line.items.map(({ uid }) => uid),
          { add, remove },
        ),
      )
      const flags = flagChanges({ add, remove })
      if (Object.keys(flags).length)
        await mailbox.store.mail.setFlags(
          mailbox.accountId,
          new Map(line.items.map(({ id }) => [id, flags])),
          mailbox.now(),
        )
      for (const { id } of line.items) changed.push(id)
    }
  }
  return changed
}

/** Gmail labels added and taken away, as a Gmail move or copy is; the store's label mailboxes follow. */
const changeLabels = async (changer: Changer, place: Located, add: string[], remove: string[]): Promise<string[]> => {
  const { mailbox } = changer
  const states = await statesOf(mailbox, place)
  const items = place.items.flatMap((item) => {
    const labels = states.get(item.uid)?.labels
    if (labels === undefined) return []
    const adds = add.filter((label) => !labels.includes(label))
    const removes = remove.filter((label) => labels.includes(label))
    return adds.length || removes.length ? [{ ...item, had: labels.filter((label) => removes.includes(label)) }] : []
  })
  if (items.length === 0) return []
  const uids = items.map(({ uid }) => uid)
  await changer.step(
    { op: "label", folder: place.folder, validity: place.validity, change: { add, remove }, items },
    () => mailbox.writes.label(place.folder, place.validity, uids, { add, remove }),
  )
  await relabel(
    mailbox,
    items.map(({ id }) => id),
    add,
    remove,
  )
  return items.map(({ id }) => id)
}

const relabel = async (mailbox: Mailbox, ids: string[], add: string[], remove: string[]) => {
  const scanned = [...add, ...remove].map(labelBox)
  const kept = add.map(labelBox).map(({ externalId }) => externalId)
  if (scanned.length === 0) return
  await mailbox.store.mail.setMailboxes(mailbox.accountId, scanned, new Map(ids.map((id) => [id, kept])), mailbox.now())
}

/** A folder move: the store's membership moves with it, and so does the stored UID where the server gave the new one. */
const moveFolder = async (changer: Changer, place: Located, to: string, op: "move" | "copy"): Promise<string[]> => {
  const { mailbox } = changer
  const states = await statesOf(mailbox, place)
  const items = place.items.flatMap((item) => {
    const state = states.get(item.uid)
    return state ? [{ ...item, ...(state.messageId ? { mid: state.messageId } : {}) }] : []
  })
  if (items.length === 0) return []
  const uids = items.map(({ uid }) => uid)
  const idOf = new Map(items.map(({ id, uid }) => [uid, id]))
  const moved = await changer.step(
    { op, folder: place.folder, validity: place.validity, to, items },
    () => (op === "move" ? mailbox.writes.move : mailbox.writes.copy)(place.folder, place.validity, uids, to),
    (done) => ({
      uids: new Map([...done.uids].flatMap(([from, uid]) => (idOf.has(from) ? [[idOf.get(from) as string, uid]] : []))),
      ...(done.validity ? { validity: done.validity } : {}),
    }),
  )
  const ids = items.map(({ id }) => id)
  const now = mailbox.now()
  await mailbox.store.mail.setMailboxes(
    mailbox.accountId,
    op === "move" ? [storeBox(place.folder), storeBox(to)] : [storeBox(to)],
    new Map(ids.map((id) => [id, [to]])),
    now,
  )
  if (op === "move") await mailbox.store.mail.forgetLocations(mailbox.accountId, place.folder, place.validity, uids)
  if (moved.validity && moved.uids.size)
    await mailbox.store.mail.setLocations(
      mailbox.accountId,
      to,
      moved.validity,
      new Map([...moved.uids].flatMap(([from, uid]) => (idOf.has(from) ? [[idOf.get(from) as string, [uid]]] : []))),
    )
  return ids
}

export const moveMessages = async (
  changer: Changer,
  located: Located[],
  target: Target,
  op: "move" | "copy",
): Promise<string[]> => {
  const changed: string[] = []
  for (const place of located) {
    const ids =
      target.kind === "labels"
        ? await changeLabels(changer, place, target.add, target.remove)
        : await moveFolder(changer, place, target.path, op)
    for (const id of ids) changed.push(id)
  }
  return changed
}

/**
 * Moves the messages to Trash, which the provider empties in its own time; until then `messages restore` brings them
 * back. On Gmail each message's labels are kept in the record first. The store marks them deleted, as a sync would.
 */
export const trashMessages = async (
  changer: Changer,
  located: Located[],
  trash: string,
  keep: (id: string, state: ServerState) => string | undefined = () => undefined,
): Promise<{ changed: string[]; kept: Record<string, number> }> => {
  const { mailbox } = changer
  const changed: string[] = []
  const kept: Record<string, number> = {}
  for (const place of located) {
    const states = await statesOf(mailbox, place)
    const items = place.items.flatMap((item) => {
      const state = states.get(item.uid)
      if (!state) return []
      const reason = keep(item.id, state)
      if (reason !== undefined) {
        kept[reason] = (kept[reason] ?? 0) + 1
        return []
      }
      return [
        {
          ...item,
          ...(state.labels ? { labels: state.labels } : {}),
          ...(state.messageId ? { mid: state.messageId } : {}),
        },
      ]
    })
    if (items.length === 0) continue
    const idOf = new Map(items.map(({ id, uid }) => [uid, id]))
    await changer.step(
      { op: "trash", folder: place.folder, validity: place.validity, to: trash, items },
      () =>
        mailbox.writes.move(
          place.folder,
          place.validity,
          items.map(({ uid }) => uid),
          trash,
        ),
      (done) => ({
        uids: new Map(
          [...done.uids].flatMap(([from, uid]) => (idOf.has(from) ? [[idOf.get(from) as string, uid]] : [])),
        ),
        ...(done.validity ? { validity: done.validity } : {}),
      }),
    )
    const ids = items.map(({ id }) => id)
    await mailbox.store.mail.markDeleted(mailbox.accountId, ids, mailbox.now())
    for (const id of ids) changed.push(id)
  }
  return { changed, kept }
}

export interface RestorePlan {
  run: string
  command: string
  started_at: string
  restorable_until: string | null
  expired: boolean
  /** Messages the run changed. */
  logged: number
  /** Messages a restore puts back: still where the run left them. */
  restorable: number
  /** Changed by the run, and no longer where it left them: restored already, moved by hand, or gone for good. */
  missing: number
  restored: number
}

const SYSTEM = new Set(["\\Inbox", "\\Important", "\\Starred", "\\Sent", "\\Drafts", "\\Spam", "\\Trash"])

const inverse = (change: StepLine["change"] = {}, item: ChangedItem) => {
  const had = new Set(item.had ?? [])
  return {
    add: (change.remove ?? []).filter((one) => had.has(one)),
    remove: (change.add ?? []).filter((one) => !had.has(one)),
  }
}

/** Where a step's messages are now: the UIDs it left them under, else found again by id or Message-ID. */
const whereNow = async (
  mailbox: Mailbox,
  folder: string,
  items: ChangedItem[],
  given: { uids?: Record<string, number>; validity?: string },
): Promise<{ validity: string; found: Map<string, number> }> => {
  const look = await mailbox.writes.locate(folder, {
    emailIds: items.map(({ id }) => id).filter(serverId),
    messageIds: items.flatMap(({ id, mid }) => (serverId(id) || mid === undefined ? [] : [mid])),
  })
  const found = new Map<string, number>()
  const same = given.validity === undefined || given.validity === look.validity
  for (const item of items) {
    const uid = look.uids.get(item.id) ?? (item.mid ? look.uids.get(item.mid) : undefined)
    if (uid !== undefined) found.set(item.id, uid)
    else if (same && given.uids?.[item.id] !== undefined) {
      const left = given.uids[item.id] as number
      const present = await mailbox.writes.state(folder, look.validity, [left])
      if (present.has(left)) found.set(item.id, left)
    }
  }
  return { validity: look.validity, found }
}

/**
 * Undoes a run, last step first, for the messages still where it left them. Without `apply` it only counts. Trash
 * brings mail back to where it was (on Gmail: to the Inbox if it was there, else All Mail, labels put back).
 */
export const restoreRun = async (
  changer: Changer,
  { run, steps, restored: before }: ChangeRun,
  path: string,
  apply: boolean,
): Promise<RestorePlan> => {
  const { mailbox } = changer
  const now = mailbox.now()
  const until = run.restorable_until ?? null
  const plan: RestorePlan = {
    run: run.id,
    command: run.command,
    started_at: run.started_at,
    restorable_until: until,
    expired: until !== null && Date.parse(until) < now,
    logged: 0,
    restorable: 0,
    missing: 0,
    restored: 0,
  }
  const restored: string[] = []
  for (const { step, done } of [...steps].reverse()) {
    const items = step.items.filter(({ id }) => !before.has(id))
    plan.logged += step.items.length
    if (items.length === 0) continue
    const folder = step.folder || (step.op === "trash" ? await allMailOf(mailbox) : step.folder)
    if (step.op === "flag" || step.op === "label") {
      // A flag or a label does not move a message, so the UID it had is still its UID.
      const { validity, found } = await whereNow(mailbox, folder, items, {
        uids: Object.fromEntries(items.map(({ id, uid }) => [id, uid])),
        validity: step.validity,
      })
      const here = items.filter(({ id }) => found.has(id))
      plan.restorable += here.length
      plan.missing += items.length - here.length
      if (!apply) continue
      for (const group of groupBy(here, (item) => JSON.stringify(inverse(step.change, item))).values()) {
        const back = inverse(step.change, group[0] as ChangedItem)
        if (back.add.length === 0 && back.remove.length === 0) continue
        const uids = group.map(({ id }) => found.get(id) as number)
        const ids = group.map(({ id }) => id)
        await changer.step(
          {
            op: step.op,
            folder,
            validity,
            change: back,
            items: group.map((item) => ({ ...item, uid: found.get(item.id) as number })),
          },
          () => (step.op === "flag" ? mailbox.writes.flag : mailbox.writes.label)(folder, validity, uids, back),
        )
        if (step.op === "flag") {
          const flags = flagChanges(back)
          if (Object.keys(flags).length)
            await mailbox.store.mail.setFlags(mailbox.accountId, new Map(ids.map((id) => [id, flags])), mailbox.now())
        } else await relabel(mailbox, ids, back.add, back.remove)
        for (const id of ids) restored.push(id)
      }
      continue
    }
    const to = step.to || (await trashOf(mailbox))
    const { validity, found } = await whereNow(mailbox, to, items, {
      ...(done?.uids ? { uids: done.uids } : {}),
      ...(done?.to_validity ? { validity: done.to_validity } : {}),
    })
    const here = items.filter(({ id }) => found.has(id))
    plan.restorable += here.length
    plan.missing += items.length - here.length
    if (!apply || here.length === 0) continue
    if (step.op === "copy") {
      if (!done?.uids)
        throw new CliError(
          "provider_unavailable",
          "the server gave no UIDs for the copies, so they cannot be told from other mail and are left in place",
          { reason: "mail.copy-not-undoable" },
        )
      const uids = here.map(({ id }) => found.get(id) as number)
      await changer.step({ op: "copy", folder: to, validity, items: here }, () =>
        mailbox.writes.expunge(to, validity, uids),
      )
      await mailbox.store.mail.setMailboxes(
        mailbox.accountId,
        [storeBox(to)],
        new Map(here.map(({ id }) => [id, []])),
        mailbox.now(),
      )
      for (const { id } of here) restored.push(id)
      continue
    }
    const gmailTrash = step.op === "trash" && mailbox.organise.labels === true
    const groups = gmailTrash
      ? groupBy(here, (item) => ((item.labels ?? []).includes("\\Inbox") ? "INBOX" : folder))
      : new Map([[folder, here]])
    for (const [back, group] of groups) {
      const uids = group.map(({ id }) => found.get(id) as number)
      await changer.step({ op: "move", folder: to, validity, to: back, items: group }, () =>
        mailbox.writes.move(to, validity, uids, back),
      )
      const ids = group.map(({ id }) => id)
      if (step.op === "move")
        await mailbox.store.mail.setMailboxes(
          mailbox.accountId,
          [storeBox(to), storeBox(back)],
          new Map(ids.map((id) => [id, [back]])),
          mailbox.now(),
        )
      for (const id of ids) restored.push(id)
    }
    if (gmailTrash) {
      const all = folder
      const labelled = here.filter((item) => (item.labels ?? []).some((label) => label !== "\\Inbox"))
      if (labelled.length) {
        const { validity: allValidity, found: inAll } = await whereNow(mailbox, all, labelled, {})
        for (const group of groupBy(labelled, (item) =>
          JSON.stringify((item.labels ?? []).filter((l) => l !== "\\Inbox").sort()),
        ).values()) {
          const labels = ((group[0] as ChangedItem).labels ?? []).filter((label) => label !== "\\Inbox")
          const placed = group.filter(({ id }) => inAll.has(id))
          if (placed.length === 0) continue
          await mailbox.writes.label(
            all,
            allValidity,
            placed.map(({ id }) => inAll.get(id) as number),
            { add: labels.filter((label) => !SYSTEM.has(label) || label === "\\Starred" || label === "\\Important") },
          )
        }
      }
    }
    if (step.op === "trash") {
      // Only an envelope comes back whole at once: it has no text to lose. Full mail is saved again by the next sync.
      const envelopes = (await mailbox.store.mail.emailRefs({ accountId: mailbox.accountId, includeDeleted: true }))
        .filter(({ externalId, mailboxes }) => found.has(externalId) && mailboxes.some(({ kind }) => kind === ENVELOPE))
        .map(({ externalId }) => externalId)
      if (envelopes.length) await mailbox.store.mail.markRestored(mailbox.accountId, envelopes, mailbox.now())
    }
  }
  if (restored.length) appendRestore(path, restored, mailbox.now())
  plan.restored = restored.length
  return plan
}
