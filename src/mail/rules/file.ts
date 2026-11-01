import { CliError } from "@wirecat/cli-base"
import { conditionKeys, type MailAction, type MailRule, type MailRuleMatch } from "@wirecat/cli-core/mail"

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

export const rulesFileOf = (text: string, path: string, exporter: string): MailRule[] => {
  const bad = (why: string) =>
    new CliError("validation_error", `${path}: ${why}`, { reason: "mail.rules-file-invalid" })
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw bad("not JSON")
  }
  const rules = (parsed as { rules?: unknown } | null)?.rules
  if (!Array.isArray(rules)) throw bad(`no rules list; write it with ${exporter}`)
  return rules.map((raw, index) => {
    const rule = (raw ?? {}) as Partial<MailRule>
    if (!ACTIONS.includes(rule.action as MailAction) || conditionKeys(rule.match ?? {}).length === 0)
      throw bad(`rule ${index + 1} needs at least one match condition and an action`)
    const match = rule.match as MailRuleMatch
    const unknown = conditionKeys(match).filter((key) => !CONDITIONS.includes(key))
    if (unknown.length) throw bad(`rule ${index + 1} has conditions mail does not know: ${unknown.join(", ")}`)
    return {
      match,
      action: rule.action as MailAction,
      ...(Array.isArray(rule.tags) ? { tags: rule.tags.filter((tag) => typeof tag === "string") } : {}),
      ...(typeof rule.reason === "string" ? { reason: rule.reason } : {}),
      ...(rule.protected === true ? { protected: true } : {}),
      ...(typeof rule.source === "string" ? { source: rule.source } : {}),
      decided_at: typeof rule.decided_at === "string" ? rule.decided_at : new Date().toISOString(),
    }
  })
}
