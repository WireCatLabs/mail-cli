import { CliError } from "@wirecat/cli-base"
import { ENVELOPE } from "@wirecat/cli-core/mail"
import { appendRestore, type ChangedItem, type ChangeRun, type StepLine } from "./changes.js"
import { serverId } from "./locate.js"
import {
  allMailOf,
  type Changer,
  flagChanges,
  groupBy,
  type Mailbox,
  relabel,
  storeBox,
  trashOf,
  valuesOf,
} from "./organise.js"

const undoing = (step: StepLine) => (step.operation_id ? { undoes: step.operation_id } : {})

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
    const left = same ? given.uids?.[item.id] : undefined
    if (uid !== undefined) found.set(item.id, uid)
    else if (left !== undefined && (await mailbox.writes.state(folder, look.validity, [left])).has(left))
      found.set(item.id, left)
  }
  return { validity: look.validity, found }
}

/**
 * The copies a copy step made, by the UIDs the server gave them (COPYUID) alone. The original and a copy share the
 * Message-ID, and on a server with OBJECTID the email id too, so finding them again by either could pick the
 * original, which undoing a copy then expunges for good.
 */
const copiesNow = async (
  mailbox: Mailbox,
  folder: string,
  items: ChangedItem[],
  done: { uids?: Record<string, number>; to_validity?: string } | undefined,
): Promise<{ validity: string; found: Map<string, number> }> => {
  const { uids, to_validity: validity } = done ?? {}
  if (!uids || !validity)
    throw new CliError(
      "provider_unavailable",
      "the server gave no UIDs for the copies, so they cannot be told from other mail and are left in place",
      { reason: "mail.copy-not-undoable" },
    )
  const left = items.flatMap(({ id }) => (uids[id] === undefined ? [] : [[id, uids[id] as number] as const]))
  const present = await mailbox.writes.state(
    folder,
    validity,
    left.map(([, uid]) => uid),
  )
  return { validity, found: new Map(left.filter(([, uid]) => present.has(uid))) }
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
  write?: string,
): Promise<RestorePlan> => {
  const chosen = write === undefined ? steps : steps.filter(({ step }) => step.operation_id === write)
  if (chosen.length === 0)
    throw new CliError(
      "not_found",
      steps.some(({ step }) => step.operation_id)
        ? `run ${run.id} has no write ${write}; its answer lists them under writes`
        : `run ${run.id} was logged before writes had ids, so it is restored whole only`,
      { reason: "mail.write-unknown" },
    )
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
  const restored = new Map<string, string[]>()
  const cameBack = (step: StepLine, ids: string[]) => {
    const key = step.operation_id ?? ""
    restored.set(key, [...(restored.get(key) ?? []), ...ids])
  }
  // A step can fail after earlier ones changed the mailbox; what came back is recorded, so the next restore skips it.
  try {
    for (const { step, done } of [...chosen].reverse()) {
      const items = step.items.filter(({ id }) => !before(step, id))
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
          const back = inverse(step.change, group[0])
          if (back.add.length === 0 && back.remove.length === 0) continue
          const uids = valuesOf(
            found,
            group.map(({ id }) => id),
          )
          const ids = group.map(({ id }) => id)
          await changer.step(
            {
              op: step.op,
              folder,
              validity,
              ...undoing(step),
              change: back,
              items: group.flatMap((item) => valuesOf(found, [item.id]).map((uid) => ({ ...item, uid }))),
            },
            () => (step.op === "flag" ? mailbox.writes.flag : mailbox.writes.label)(folder, validity, uids, back),
          )
          if (step.op === "flag") {
            const flags = flagChanges(back)
            if (Object.keys(flags).length)
              await mailbox.store.mail.setFlags(mailbox.accountId, new Map(ids.map((id) => [id, flags])), mailbox.now())
          } else await relabel(mailbox, ids, back.add, back.remove)
          cameBack(step, ids)
        }
        continue
      }
      const to = step.to || (await trashOf(mailbox))
      const { validity, found } =
        step.op === "copy"
          ? await copiesNow(mailbox, to, items, done)
          : await whereNow(mailbox, to, items, {
              ...(done?.uids ? { uids: done.uids } : {}),
              ...(done?.to_validity ? { validity: done.to_validity } : {}),
            })
      const here = items.filter(({ id }) => found.has(id))
      plan.restorable += here.length
      plan.missing += items.length - here.length
      if (!apply || here.length === 0) continue
      if (step.op === "copy") {
        const uids = valuesOf(
          found,
          here.map(({ id }) => id),
        )
        await changer.step({ op: "copy", folder: to, validity, ...undoing(step), items: here }, () =>
          mailbox.writes.expunge(to, validity, uids),
        )
        await mailbox.store.mail.setMailboxes(
          mailbox.accountId,
          [storeBox(to)],
          new Map(here.map(({ id }) => [id, []])),
          mailbox.now(),
        )
        cameBack(
          step,
          here.map(({ id }) => id),
        )
        continue
      }
      const gmailTrash = step.op === "trash" && mailbox.organise.labels === true
      const groups = gmailTrash
        ? groupBy(here, (item) => ((item.labels ?? []).includes("\\Inbox") ? "INBOX" : folder))
        : new Map([[folder, here]])
      for (const [back, group] of groups) {
        const uids = valuesOf(
          found,
          group.map(({ id }) => id),
        )
        await changer.step({ op: "move", folder: to, validity, to: back, ...undoing(step), items: group }, () =>
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
        cameBack(step, ids)
      }
      if (gmailTrash) {
        const all = await allMailOf(mailbox)
        const labelled = here.filter((item) => (item.labels ?? []).some((label) => label !== "\\Inbox"))
        if (labelled.length) {
          const { validity: allValidity, found: inAll } = await whereNow(mailbox, all, labelled, {})
          for (const group of groupBy(labelled, (item) =>
            JSON.stringify((item.labels ?? []).filter((l) => l !== "\\Inbox").sort()),
          ).values()) {
            const labels = (group[0].labels ?? []).filter((label) => label !== "\\Inbox")
            const placed = group.filter(({ id }) => inAll.has(id))
            if (placed.length === 0) continue
            const change = {
              add: labels.filter((label) => !SYSTEM.has(label) || label === "\\Starred" || label === "\\Important"),
            }
            const uids = valuesOf(
              inAll,
              placed.map(({ id }) => id),
            )
            // Its own write, so it has an id, a line in the log and a place in the answer's writes.
            await changer.step(
              {
                op: "label",
                folder: all,
                validity: allValidity,
                ...undoing(step),
                change,
                items: placed.flatMap(({ id, mid }) =>
                  valuesOf(inAll, [id]).map((uid) => ({ id, uid, had: [], ...(mid ? { mid } : {}) })),
                ),
              },
              () => mailbox.writes.label(all, allValidity, uids, change),
            )
          }
        }
      }
      if (step.op === "trash") {
        // Only an envelope comes back whole at once: it has no text to lose. Full mail is saved again by the next sync.
        const envelopes = (await mailbox.store.mail.emailRefs({ accountId: mailbox.accountId, includeDeleted: true }))
          .filter(
            ({ externalId, mailboxes }) => found.has(externalId) && mailboxes.some(({ kind }) => kind === ENVELOPE),
          )
          .map(({ externalId }) => externalId)
        if (envelopes.length) await mailbox.store.mail.markRestored(mailbox.accountId, envelopes, mailbox.now())
      }
    }
  } finally {
    for (const [undoes, ids] of restored) appendRestore(path, ids, mailbox.now(), undoes || undefined)
  }
  plan.restored = [...restored.values()].reduce((sum, ids) => sum + ids.length, 0)
  return plan
}
