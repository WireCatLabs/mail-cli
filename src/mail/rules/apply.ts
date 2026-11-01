import type { Listed, MailSource } from "@wirecat/cli-core/mail"
import {
  decide,
  ENVELOPE,
  envelopeBox,
  factsOf,
  type MailAccount,
  type MailRule,
  type MailRuleMatch,
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
  now = Date.now,
}: {
  store: MessageStore
  source: Pick<MailSource, "list">
  account: Pick<MailAccount, "address" | "rules">
  folders: readonly string[]
  since: Date
  apply: boolean
  now?: () => number
}): Promise<ApplyResult> => {
  const startedAt = now()
  const key: AccountKey = { provider: "email", account: account.address.toLowerCase() }
  const rules = account.rules ?? []
  const effects = rules
    .filter(({ action, protected: kept }) => action === ENVELOPE && !kept)
    .map((rule): RuleEffect => ({ rule, emails: 0, bytes: 0 }))
  const result: ApplyResult = {
    account: key.account,
    applied: apply,
    listed: 0,
    envelopes: 0,
    bytes: 0,
    skipMatched: 0,
    protectedKept: 0,
    tagged: 0,
    rules: effects,
  }
  if (effects.length === 0 && !rules.some(({ tags, protected: kept }) => tags?.length || kept)) return result
  const stored = await store.accounts.storedAccount(key).catch(() => null)
  if (stored === null) return result

  const listed = new Map<string, Listed>()
  for (const folder of folders)
    for (const item of await source.list(since, folder, { headers: true })) listed.set(item.messageId, item)
  result.listed = listed.size

  const full = new Set(
    (await store.mail.emailRefs({ accountId: stored.id }))
      .filter(({ deleted, mailboxes }) => !deleted && !mailboxes.some(({ kind }) => kind === ENVELOPE))
      .map(({ externalId }) => externalId),
  )
  const effectOf = (match: MailRuleMatch) => effects.find(({ rule }) => sameMatch(rule.match, match)) as RuleEffect
  const all = new Set((await store.mail.emailRefs({ accountId: stored.id })).map(({ externalId }) => externalId))
  const factsFor = factsOf([...listed.values()], rules)
  const tagger = ruleTagger(store, key)
  const chosen: { item: Listed; rule: MailRule }[] = []
  for (const item of listed.values()) {
    const facts = factsFor(item)
    const tags = all.has(item.messageId) ? tagsOf(rules, facts) : []
    if (tags.length) {
      result.tagged++
      if (apply) await tagger.tag({ type: "message", chatId: item.threadId, messageId: item.messageId }, tags)
    }
    if (!full.has(item.messageId)) continue
    const rule = decide(rules, facts)
    if (rule?.protected) result.protectedKept++
    if (rule?.action === "skip") result.skipMatched++
    if (rule?.action === ENVELOPE) chosen.push({ item, rule })
  }

  for (const { item, rule } of chosen) {
    const email = await store.mail.email(stored.id, item.messageId)
    if (email === null) continue
    const bytes =
      textBytes(email.bodyText) +
      textBytes(email.bodyHtml) +
      email.attachments.reduce((sum, { text }) => sum + textBytes(text), 0)
    const effect = effectOf(rule.match)
    effect.emails++
    effect.bytes += bytes
    result.envelopes++
    result.bytes += bytes
    if (!apply) continue
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
  const tagging = tagger.outcome()
  if (apply) await settleRuleTags(store, stored.id, rules, tagging)
  if (tagging.reused.length) result.tagsReused = tagging.reused
  if (tagging.skipped.length) result.tagsSkipped = tagging.skipped
  return result
}
