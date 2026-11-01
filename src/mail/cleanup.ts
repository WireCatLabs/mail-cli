import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { resolvePaths } from "@wirecat/cli-base"
import { decide, describeMatch, ENVELOPE, factsOf, type Listed, listedOf, type MailRule } from "@wirecat/cli-core/mail"
import { storePath } from "@wirecat/cli-core/store"
import type { Mailbox } from "./organise.js"

const DAY = 86_400_000
const MIN_AGE_DAYS = 30
const BACKUP_DAYS = 8
/** A first cleanup moves few, so the owner can check them by hand before trusting the rules with more. */
export const FIRST_RUN_LIMIT = 100
export const CLEANUP_LIMIT = 5_000

/** Labels Gmail sets itself; any other label on a message is the owner's, and keeps it out of the trash. */
const SYSTEM_LABELS = new Set(["Inbox", "Important", "Starred", "Sent", "Drafts", "Spam", "Trash"])

export type KeptReason =
  | "no_rule"
  | "protected"
  | "rule_changed"
  | "replied"
  | "starred"
  | "sent"
  | "labelled"
  | "too_new"
  | "before_since"

export interface RuleTotals {
  rule: string
  candidates: number
  bytes: number
}

export interface Cleanup {
  ids: string[]
  /** Envelopes in the store for this mailbox. */
  envelopes: number
  candidates: number
  bytes: number
  kept: Partial<Record<KeptReason, number>>
  rules: RuleTotals[]
  limit: number
  first_run: boolean
  backup: { at: string | null; fresh: boolean; marker: string }
}

const userLabels = (item: Listed) => (item.labels ?? []).filter((label) => !SYSTEM_LABELS.has(label))

/** Why an envelope stays, or undefined when the cleanup may trash it. Moved from memo's `mail delete`. */
const keptBecause = (
  item: Listed,
  rule: MailRule | undefined,
  replied: ReadonlySet<string>,
  now: number,
): KeptReason | undefined => {
  if (rule === undefined) return "no_rule"
  if (rule.protected || rule.action === "keep") return "protected"
  if (rule.action !== ENVELOPE && rule.action !== "skip") return "rule_changed"
  const from = item.headers?.from
  if (from !== undefined && replied.has(from)) return "replied"
  const labels = item.labels ?? []
  if (item.flagged || labels.includes("Starred") || labels.includes("Important")) return "starred"
  if (labels.includes("Sent") || labels.includes("Drafts")) return "sent"
  if (userLabels(item).some((label) => !rule.tags?.includes(label))) return "labelled"
  if (now - Date.parse(item.receivedAt) < MIN_AGE_DAYS * DAY) return "too_new"
  return undefined
}

/** The weekly store backup's marker, written by the backup script when a copy passed its check. */
export const backupOf = (env: NodeJS.ProcessEnv, now: number): Cleanup["backup"] => {
  const marker = join(dirname(storePath(env)), "backups", "last.json")
  let at: string | null = null
  try {
    const value = (JSON.parse(readFileSync(marker, "utf8")) as { at?: unknown }).at
    if (typeof value === "string" && !Number.isNaN(Date.parse(value))) at = value
  } catch {}
  return { at, fresh: at !== null && now - Date.parse(at) < BACKUP_DAYS * DAY, marker }
}

/** No cleanup has moved mail of this mailbox before, here or in memo. */
export const firstCleanup = (env: NodeJS.ProcessEnv, account: string): boolean => {
  const own = join(resolvePaths({ appName: "mail-cli", prefix: "MAIL", env }).state, "changes", account.toLowerCase())
  const memo = join(resolvePaths({ appName: "cli-memo", prefix: "MEMO", env }).state, "mail-trash")
  const moved = (path: string, test: (text: string) => boolean) => {
    try {
      return test(readFileSync(path, "utf8"))
    } catch {
      return false
    }
  }
  if (existsSync(own))
    for (const name of readdirSync(own))
      if (moved(join(own, name), (text) => text.includes("delete --rules") && text.includes('"type":"done"')))
        return false
  if (existsSync(memo))
    for (const folder of readdirSync(memo))
      for (const name of existsSync(join(memo, folder)) ? readdirSync(join(memo, folder)) : [])
        if (
          moved(
            join(memo, folder, name),
            (text) => text.includes(`"account":"${account.toLowerCase()}"`) && /"moved":\["/.test(text),
          )
        )
          return false
  return true
}

/**
 * The envelopes the owner's rules would have the mailbox let go, each decided again with today's rules, labels and
 * flags as the last sync stored them; oldest first, at most `limit`.
 */
export const cleanupOf = async (
  mailbox: Mailbox,
  rules: readonly MailRule[],
  { limit, since, env }: { limit: number; since?: Date; env: NodeJS.ProcessEnv },
): Promise<Cleanup> => {
  const now = mailbox.now()
  const first = firstCleanup(env, mailbox.key.account)
  const cap = first ? Math.min(limit, FIRST_RUN_LIMIT) : limit
  const facts = (await mailbox.store.mail.emailFacts({ accountId: mailbox.accountId })).map(listedOf)
  const envelopes = facts.filter(({ envelope }) => envelope)
  const replied = new Set(
    facts.filter(({ labels }) => labels?.includes("Sent")).flatMap(({ headers }) => headers?.to ?? []),
  )
  const factsFor = factsOf(facts, rules)
  const kept: Cleanup["kept"] = {}
  const totals = new Map<string, RuleTotals>()
  const chosen: string[] = []
  let candidates = 0
  let bytes = 0
  for (const item of envelopes) {
    const rule = decide(rules, factsFor(item))
    const reason =
      since !== undefined && Date.parse(item.receivedAt) < since.getTime()
        ? "before_since"
        : keptBecause(item, rule, replied, now)
    if (reason !== undefined) {
      kept[reason] = (kept[reason] ?? 0) + 1
      continue
    }
    const name = describeMatch((rule as MailRule).match)
    const total = totals.get(name) ?? { rule: name, candidates: 0, bytes: 0 }
    total.candidates++
    total.bytes += item.size ?? 0
    totals.set(name, total)
    candidates++
    bytes += item.size ?? 0
    chosen.push(item.messageId)
  }
  return {
    ids: chosen.slice(0, cap),
    envelopes: envelopes.length,
    candidates,
    bytes,
    kept,
    rules: [...totals.values()].sort((a, b) => b.candidates - a.candidates),
    limit: cap,
    first_run: first,
    backup: backupOf(env, now),
  }
}
