import { CliError } from "@wirecat/cli-base"
import type { BudgetStop } from "@wirecat/cli-core/background"
import type { Listed, MailSource } from "@wirecat/cli-core/mail"
import {
  decide,
  ENVELOPE,
  envelopeBox,
  factsOf,
  listedOf,
  type MailAccount,
  type MailFacts,
  type MailRule,
  ruleTagger,
  sameMatch,
  settleRuleTags,
  type TagOutcome,
  tagsOf,
} from "@wirecat/cli-core/mail"
import type { AccountKey, MessageStore } from "@wirecat/cli-core/store"

export interface RuleEffect {
  rule: MailRule
  emails: number
  /** Text this rule's emails hold in the store: bodies and attachment text. */
  bytes: number
}

export interface ApplyResult {
  account: string
  applied: boolean
  listed: number
  /** Stored in full, matched by an envelope rule: cut to envelopes, or would be. */
  envelopes: number
  bytes: number
  /** Stored in full, matched only by a skip rule: left as stored, since removing them is another decision. */
  skipMatched: number
  /** Stored in full, matched by a protected rule: never cut, whatever else matches. */
  protectedKept: number
  /** Stored emails a rule's tag was put on, or would be. */
  tagged: number
  rules: RuleEffect[]
  tagsReused?: TagOutcome["reused"]
  tagsSkipped?: TagOutcome["skipped"]
  /** Why the run stopped before the end of the window; `cursor` goes on from there. */
  stopped?: BudgetStop
  cursor?: string
}

type Totals = Pick<ApplyResult, "listed" | "envelopes" | "bytes" | "skipMatched" | "protectedKept" | "tagged">

/**
 * Where a stopped run got to: the folders before `folder` are done, and in it every UID from `below` up. It carries
 * the counts so far, so the run that ends the window answers for all of it.
 */
interface Position {
  folder: string
  validity?: string
  below: number
  applied: boolean
  totals: Totals
}

const cursorOf = (position: Position): string => Buffer.from(JSON.stringify(position)).toString("base64url")

const positionOf = (cursor: string, folders: readonly string[], apply: boolean): Position => {
  const refuse = () =>
    new CliError("validation_error", "this cursor is not one a stopped run gave for these folders and this mode", {
      param: "cursor",
      reason: "mail.cursor-foreign",
    })
  let position: Position
  try {
    position = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
  } catch {
    throw refuse()
  }
  if (
    typeof position?.folder !== "string" ||
    typeof position.below !== "number" ||
    typeof position.totals !== "object" ||
    position.applied !== apply ||
    !folders.includes(position.folder)
  )
    throw refuse()
  return position
}

/**
 * A sender's score and whether the owner wrote to it, from the mail stored in the window, so no batch and no resumed
 * part sees a sender other than the rest do. The headers the server gave still decide everything else.
 */
const storedAggregates = async (
  store: MessageStore,
  accountId: number,
  rules: readonly MailRule[],
  since: Date,
): Promise<(item: Listed) => MailFacts> => {
  const from = since.toISOString()
  // listedOf gives a stored email no folder, so mail the owner sent is marked Sent as scoreSenders marks it.
  const stored = (await store.mail.emailFacts({ accountId }))
    .map((email) => {
      const item = listedOf(email)
      return email.outgoing && !item.labels?.includes("Sent")
        ? { ...item, labels: [...(item.labels ?? []), "Sent"] }
        : item
    })
    .filter((item) => item.receivedAt >= from)
  const known = new Map(stored.map((item) => [item.messageId, item]))
  const factsFor = factsOf(stored, rules)
  return (item) => {
    const { score, replied } = factsFor(known.get(item.messageId) ?? item)
    return { ...item, ...(score === undefined ? {} : { score }), ...(replied === undefined ? {} : { replied }) }
  }
}

const textBytes = (text: string | null | undefined) => (text ? Buffer.byteLength(text) : 0)

/**
 * Cuts mail stored in full that an envelope rule now matches down to what an envelope sync stores. Matching
 * reads the account's headers from the server, as sync does: List-Id is not stored with a full email.
 */
export const applyRules = async ({
  store,
  source,
  account,
  folders,
  since,
  apply,
  cursor,
  take = () => null,
  now = Date.now,
}: {
  store: MessageStore
  source: Pick<MailSource, "list" | "search" | "listBatch">
  account: Pick<MailAccount, "address" | "rules">
  folders: readonly string[]
  since: Date
  apply: boolean
  /** Where an earlier run of the same window stopped. */
  cursor?: string
  /** Asked before each batch of headers: `null` to go on, otherwise why the run stops here. */
  take?: () => BudgetStop | null
  now?: () => number
}): Promise<ApplyResult> => {
  const startedAt = now()
  const key: AccountKey = { provider: "email", account: account.address.toLowerCase() }
  const rules = account.rules ?? []
  const effects = rules
    .filter(({ action, protected: kept }) => action === ENVELOPE && !kept)
    .map((rule): RuleEffect => ({ rule, emails: 0, bytes: 0 }))
  const from = cursor === undefined ? undefined : positionOf(cursor, folders, apply)
  const result: ApplyResult = {
    account: key.account,
    applied: apply,
    listed: 0,
    envelopes: 0,
    bytes: 0,
    skipMatched: 0,
    protectedKept: 0,
    tagged: 0,
    ...from?.totals,
    rules: effects,
  }
  const listedBefore = result.listed
  if (effects.length === 0 && !rules.some(({ tags, protected: kept }) => tags?.length || kept)) return result
  const stored = await store.accounts.storedAccount(key).catch(() => null)
  if (stored === null) return result

  const full = new Set(
    (await store.mail.emailRefs({ accountId: stored.id }))
      .filter(({ deleted, mailboxes }) => !deleted && !mailboxes.some(({ kind }) => kind === ENVELOPE))
      .map(({ externalId }) => externalId),
  )
  const all = new Set((await store.mail.emailRefs({ accountId: stored.id })).map(({ externalId }) => externalId))
  const tagger = ruleTagger(store, key)
  const listed = new Map<string, Listed>()
  const aggregatesOf = await storedAggregates(store, stored.id, rules, since)

  const envelope = async (item: Listed, rule: MailRule) => {
    const email = await store.mail.email(stored.id, item.messageId)
    if (email === null) return
    const bytes =
      textBytes(email.bodyText) +
      textBytes(email.bodyHtml) +
      email.attachments.reduce((sum, { text }) => sum + textBytes(text), 0)
    const effect = effects.find((one) => sameMatch(one.rule.match, rule.match))
    if (effect) {
      effect.emails++
      effect.bytes += bytes
    }
    result.envelopes++
    result.bytes += bytes
    if (!apply) return
    const [placed] = await store.mail.inThreads(stored.id, [item.messageId])
    const subject = email.subject ?? item.headers?.subject
    const listId = item.headers?.listId
    await store.mail.saveThread({
      accountId: stored.id,
      externalId: placed?.threadExternalId ?? item.threadId,
      now: startedAt,
      emails: [
        {
          externalId: item.messageId,
          subject: null,
          from: email.fromAddress === null ? null : { address: email.fromAddress, name: email.fromName },
          sentAt: email.sentAt,
          bodyText: null,
          bodyHtml: null,
          snippet: null,
          size: email.size ?? item.size ?? null,
          mailboxes: [envelopeBox(rule.match)],
          mailRuleId: rule.id ?? null,
          attachments: [],
          metadata: {
            ...email.metadata,
            rule: { action: rule.action, match: { ...rule.match } },
            ...(subject ? { subject } : {}),
            ...(listId ? { listId } : {}),
          },
        },
      ],
    })
  }

  // Each batch is decided and saved before the next is read, so a run the deadline stops keeps what it did.
  const settle = async (batch: Listed[]) => {
    const fresh = batch.filter(({ messageId }) => !listed.has(messageId))
    for (const item of fresh) listed.set(item.messageId, item)
    for (const item of fresh) {
      const facts = aggregatesOf(item)
      const tags = all.has(item.messageId) ? tagsOf(rules, facts) : []
      if (tags.length) {
        result.tagged++
        if (apply) await tagger.tag({ type: "message", chatId: item.threadId, messageId: item.messageId }, tags)
      }
      if (!full.has(item.messageId)) continue
      const rule = decide(rules, facts)
      if (rule?.protected) result.protectedKept++
      if (rule?.action === "skip") result.skipMatched++
      if (rule?.action === ENVELOPE) await envelope(item, rule)
    }
  }

  const slice = source.listBatch ?? 200
  walk: for (const folder of folders.slice(from === undefined ? 0 : folders.indexOf(from.folder))) {
    if (source.search === undefined) {
      await settle(await source.list(since, folder, { headers: true }))
      continue
    }
    const searched = await source.search(since, folder)
    // A folder whose UIDVALIDITY changed since the cursor was given, or that has none, is read again from its newest.
    const below =
      from?.folder === folder && from.validity !== undefined && from.validity === searched.validity
        ? from.below
        : Number.POSITIVE_INFINITY
    // Newest first, so a run that stops early has handled the mail the owner is most likely to look at.
    const uids = searched.uids.filter((uid) => Number(uid) < below).sort((a, b) => Number(b) - Number(a))
    for (let start = 0; start < uids.length; start += slice) {
      const stop = take()
      if (stop !== null) {
        result.stopped = stop
        const { envelopes, bytes, skipMatched, protectedKept, tagged } = result
        result.cursor = cursorOf({
          folder,
          ...(searched.validity === undefined ? {} : { validity: searched.validity }),
          below: Number(uids[start]) + 1,
          applied: apply,
          totals: { listed: listedBefore + listed.size, envelopes, bytes, skipMatched, protectedKept, tagged },
        })
        break walk
      }
      const part = uids.slice(start, start + slice)
      await settle(await source.list(since, folder, { headers: true, searched: { ...searched, uids: part } }))
    }
  }
  result.listed = listedBefore + listed.size

  const tagging = tagger.outcome()
  if (apply) await settleRuleTags(store, stored.id, rules, tagging)
  if (tagging.reused.length) result.tagsReused = tagging.reused
  if (tagging.skipped.length) result.tagsSkipped = tagging.skipped
  return result
}
