import { CliError } from "@wirecat/cli-base"
import {
  conditionKeys,
  type MailAction,
  type MailRule,
  type MailRuleMatch,
  MEETING_NOTES_PROVIDERS,
  PRESET_NAMES,
} from "@wirecat/cli-core/mail"
import * as v from "valibot"

/** What `rules export` prints and `rules import` reads back; memo writes and reads the same file. */
export interface RulesFile {
  version: 1
  account: string
  rules: Omit<MailRule, "id">[]
}

const ACTIONS: readonly MailAction[] = ["skip", "envelope", "keep"]

const CONDITIONS: readonly (keyof MailRuleMatch)[] = [
  "from",
  "from_contains",
  "domain",
  "to",
  "list_id",
  "subject",
  "older_than_days",
  "larger_than_bytes",
  "has_attachments",
  "label",
  "unread",
  "bulk",
  "score_at_least",
  "preset",
]

const text = v.optional(v.string())
const count = v.optional(v.number())
const flag = v.optional(v.boolean())
const MATCH = v.object({
  from: text,
  from_contains: text,
  domain: text,
  to: text,
  list_id: text,
  subject: text,
  older_than_days: count,
  larger_than_bytes: count,
  has_attachments: flag,
  label: text,
  unread: flag,
  bulk: flag,
  score_at_least: count,
  preset: v.optional(v.picklist(PRESET_NAMES)),
}) satisfies v.GenericSchema<unknown, MailRuleMatch>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const actionOf = (value: unknown): MailAction | undefined => ACTIONS.find((action) => action === value)

export const rulesFileOf = (text: string, path: string, exporter: string): MailRule[] => {
  const bad = (why: string) =>
    new CliError("validation_error", `${path}: ${why}`, { reason: "mail.rules-file-invalid" })
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw bad("not JSON")
  }
  const rules = isRecord(parsed) ? parsed.rules : undefined
  if (!Array.isArray(rules)) throw bad(`no rules list; write it with ${exporter}`)
  return rules.map((raw, index) => {
    const rule = isRecord(raw) ? raw : {}
    const action = actionOf(rule.action)
    const given = isRecord(rule.match) ? rule.match : {}
    const named = Object.keys(given).filter((key) => given[key] !== undefined)
    if (action === undefined || named.length === 0)
      throw bad(`rule ${index + 1} needs at least one match condition and an action`)
    const unknown = named.filter((key) => !CONDITIONS.some((condition) => condition === key))
    if (unknown.length) throw bad(`rule ${index + 1} has conditions mail does not know: ${unknown.join(", ")}`)
    const match = v.safeParse(MATCH, given)
    if (!match.success) throw bad(`rule ${index + 1} has a condition of the wrong type`)
    if (conditionKeys(match.output).length === 0)
      throw bad(`rule ${index + 1} needs at least one match condition and an action`)
    return {
      match: match.output,
      action,
      ...(Array.isArray(rule.tags) ? { tags: rule.tags.filter((tag) => typeof tag === "string") } : {}),
      ...(typeof rule.reason === "string" ? { reason: rule.reason } : {}),
      ...(rule.protected === true ? { protected: true } : {}),
      ...(typeof rule.meeting_notes === "string" && MEETING_NOTES_PROVIDERS.includes(rule.meeting_notes)
        ? { meeting_notes: rule.meeting_notes }
        : {}),
      ...(typeof rule.source === "string" ? { source: rule.source } : {}),
      decided_at: typeof rule.decided_at === "string" ? rule.decided_at : new Date().toISOString(),
    }
  })
}
