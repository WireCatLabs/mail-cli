import { CliError } from "@wirecat/cli-base"
import type { AppIdentity } from "@wirecat/cli-core/cli"
import { decodedLabelName } from "@wirecat/cli-core/mail"
import { type GuardRequest, guardedWrite, newOperationId, type SendGuard } from "@wirecat/cli-core/sends"
import type { AccountKey, MessageStore } from "@wirecat/cli-core/store"
import type { Organise } from "../providers.js"
import type { FolderInfo, MailWrites, ServerState } from "./backend.js"
import type { ChangeLog, StepLine } from "./changes.js"
import type { Located } from "./locate.js"

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
    throw new CliError("validation_error", "\\Deleted is how a server expunges mail", {
      param: "flag",
      reason: "mail.flag-deleted",
    })
  if (!KEYWORD.test(word))
    throw new CliError(
      "validation_error",
      `"${given}" is no flag: give read, flagged, answered, draft, or a keyword of letters, digits and $._-`,
      { param: "flag" },
    )
  return word
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

export const allMailOf = async (mailbox: Mailbox): Promise<string> => {
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
    throw new CliError("validation_error", "moving to Trash is a deletion", {
      param: "folder",
      reason: "mail.move-to-trash",
    })
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

export const storeBox = (folder: string) => ({ externalId: folder, name: folder, kind: null })
const labelBox = (raw: string) => {
  const name = decodedLabelName(raw)
  return { externalId: `label:${name}`, name, kind: "label" }
}

/** One write a change made, as its answer names it (WC-OUT-10). */
export interface Write {
  operation_id: string
  op: StepLine["op"]
  folder: string
  to?: string
  messages: number
  undoes?: string
}

/** Runs one step against the server under the guard, recording it before it goes and once it is done. */
export class Changer {
  readonly writes: Write[] = []

  constructor(
    readonly mailbox: Mailbox,
    readonly guard: SendGuard,
    /** A preview passes a log that records nothing. */
    readonly log: Pick<ChangeLog, "begin" | "done">,
    readonly key: string,
    readonly action: "message-flag" | "message-move" | "message-copy" | "message-delete" | "message-restore",
  ) {}

  async step<T>(
    line: Omit<StepLine, "type" | "step" | "operation_id">,
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
    const step = this.log.begin({ ...line, operation_id: request.operationId })
    const done = await guardedWrite(this.guard, request, act)
    this.log.done(
      step,
      line.items.map(({ id }) => id),
      moved?.(done),
    )
    this.writes.push({
      operation_id: request.operationId,
      op: line.op,
      folder: line.folder,
      ...(line.to ? { to: line.to } : {}),
      messages: line.items.length,
      ...(line.undoes ? { undoes: line.undoes } : {}),
    })
    return done
  }
}

const statesOf = async (mailbox: Mailbox, { folder, validity, items }: Located) =>
  mailbox.writes.state(
    folder,
    validity,
    items.map(({ uid }) => uid),
  )

export const groupBy = <T>(items: T[], keyOf: (item: T) => string) => {
  const groups = new Map<string, [T, ...T[]]>()
  for (const item of items) {
    const group = groups.get(keyOf(item))
    if (group) group.push(item)
    else groups.set(keyOf(item), [item])
  }
  return groups
}

/** The values of `keys` that `map` holds, in order; a key it lacks is left out. */
export const valuesOf = <K, V>(map: ReadonlyMap<K, V>, keys: readonly K[]): V[] =>
  keys.flatMap((key) => {
    const value = map.get(key)
    return value === undefined ? [] : [value]
  })

/** A server's answer keyed by UID, keyed by message id instead; a UID with no id is left out. */
const byId = <V>(uids: ReadonlyMap<number, V>, idOf: ReadonlyMap<number, string>): Map<string, V> =>
  new Map(
    [...uids].flatMap(([uid, value]) => {
      const id = idOf.get(uid)
      return id === undefined ? [] : [[id, value] as const]
    }),
  )

export const flagChanges = (change: { add: string[]; remove: string[] }) => ({
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
      const [{ add, remove }] = group
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

export const relabel = async (mailbox: Mailbox, ids: string[], add: string[], remove: string[]) => {
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
      uids: byId(done.uids, idOf),
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
      new Map([...byId(moved.uids, idOf)].map(([id, uid]) => [id, [uid]])),
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
        uids: byId(done.uids, idOf),
        ...(done.validity ? { validity: done.validity } : {}),
      }),
    )
    const ids = items.map(({ id }) => id)
    await mailbox.store.mail.markDeleted(mailbox.accountId, ids, mailbox.now())
    for (const id of ids) changed.push(id)
  }
  return { changed, kept }
}
