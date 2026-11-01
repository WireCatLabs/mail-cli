import { CliError } from "@wirecat/cli-base"
import type { MailRule, MailRuleMatch } from "@wirecat/cli-core/mail"
import { isAddress, senderMatch } from "./query.js"

export interface FiltersProposal {
  rules: MailRule[]
  skipped: { filter: string; why: string }[]
}

type Raw = Record<string, unknown>

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined

const list = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap((item) => (typeof item === "string" ? [item] : [])) : []

const yes = (value: unknown) => value === true || value === "true"

const SYSTEM = new Set(["INBOX", "UNREAD", "SPAM", "TRASH", "IMPORTANT", "STARRED", "CATEGORY_PROMOTIONS"])

/** `a OR b`, `(a OR b)`, `{a b}`: Gmail's ways of writing either of several values. */
const alternatives = (value: string): string[] =>
  value
    .replace(/^[({]|[)}]$/g, "")
    .split(/\s+OR\s+|\s+|,/)
    .map((part) => part.trim())
    .filter((part) => part !== "" && part !== "OR")

interface Query {
  from: string[]
  to: string[]
  words: string[]
  attachment: boolean
  unknown: string[]
}

/**
 * A filter's search query, as the Takeout export writes it (`from:a from:b to:me@x.example word`). A sender cannot
 * be two addresses at once, so repeated from: or to: terms are read as either one: one rule per term.
 */
const queryOf = (query: string): Query => {
  const parsed: Query = { from: [], to: [], words: [], attachment: false, unknown: [] }
  for (const [, field, grouped, quoted, plain, word] of query.matchAll(
    /(\w+):(?:([({][^)}]*[)}])|"([^"]*)"|(\S+))|(\S+)/g,
  )) {
    if (word !== undefined) {
      if (word !== "OR") parsed.words.push(word.replace(/^"|"$/g, ""))
      continue
    }
    const value = grouped ?? quoted ?? plain ?? ""
    switch (field?.toLowerCase()) {
      case "from":
        for (const sender of alternatives(value)) parsed.from.push(sender)
        break
      case "to":
      case "cc":
        for (const recipient of alternatives(value)) parsed.to.push(recipient)
        break
      case "subject":
        for (const part of value.replace(/^[({]|[)}]$/g, "").split(/\s+/)) if (part) parsed.words.push(part)
        break
      case "has":
        if (/^attachments?$/i.test(value)) parsed.attachment = true
        else parsed.unknown.push(`has:${value}`)
        break
      default:
        parsed.unknown.push(`${field}:`)
    }
  }
  return parsed
}

/** The matches one filter's conditions make: one per sender or recipient it names, each with the shared rest. */
const matchesOf = (criteria: Raw): MailRuleMatch[] | string => {
  const query = queryOf(
    [
      text(criteria.query),
      text(criteria.hasTheWord),
      text(criteria.from) && `from:(${text(criteria.from)})`,
      text(criteria.to) && `to:(${text(criteria.to)})`,
    ]
      .filter(Boolean)
      .join(" "),
  )
  if (text(criteria.negatedQuery) ?? text(criteria.doesNotHaveTheWord))
    return "it excludes words, which mail rules cannot do"
  if (criteria.size !== undefined) return "it matches size, which this import does not map"
  if (query.unknown.length) return `it uses ${query.unknown.join(", ")}, which this import does not map`
  const badTo = query.to.find((value) => !isAddress(value))
  if (badTo !== undefined) return "it names a recipient that is not one address"
  const subject = [...query.words, ...(text(criteria.subject) ? [text(criteria.subject) as string] : [])].join(" ")
  const shared: MailRuleMatch = {
    ...(subject === "" ? {} : { subject }),
    ...(query.attachment || yes(criteria.hasAttachment) ? { has_attachments: true } : {}),
  }
  const senders = query.from.length ? query.from.map(senderMatch) : [{}]
  const recipients: MailRuleMatch[] = query.to.length ? query.to.map((to) => ({ to: to.toLowerCase() })) : [{}]
  const matches = senders.flatMap((sender) => recipients.map((recipient) => ({ ...sender, ...recipient, ...shared })))
  return Object.keys(matches[0] ?? {}).length === 0 ? "it has no condition a mail rule can match" : matches
}

/**
 * One filter, in any shape Google writes them: the Gmail API's `{criteria, action}` (developers.google.com,
 * users.settings.filters), the settings export's flat properties (`from`, `hasTheWord`, `shouldArchive`, `label`),
 * or Takeout's `{query, labelsToAdd, labelsToRemove}`. Words are matched in the subject only; Gmail searched the
 * whole email, so such a rule says so in its reason.
 */
const rulesOf = (raw: Raw, decidedAt: string): MailRule[] | string => {
  const criteria = (raw.criteria as Raw | undefined) ?? raw
  const action = (raw.action as Raw | undefined) ?? raw
  const matches = matchesOf(criteria)
  if (typeof matches === "string") return matches
  // The API writes system labels as INBOX, Takeout as Inbox.
  const removed = [...list(action.removeLabelIds), ...list(action.labelsToRemove)].map((id) => id.toUpperCase())
  const addedAsWritten = [...list(action.addLabelIds), ...list(action.labelsToAdd)]
  const added = addedAsWritten.map((id) => id.toUpperCase())
  const hides =
    removed.includes("INBOX") ||
    removed.includes("UNREAD") ||
    added.includes("TRASH") ||
    yes(action.shouldArchive) ||
    yes(action.shouldMarkAsRead) ||
    yes(action.shouldTrash)
  const tags = [
    ...addedAsWritten.filter((id) => !SYSTEM.has(id.toUpperCase())),
    ...(text(action.label) === undefined ? [] : [text(action.label) as string]),
  ]
  if (!hides && tags.length === 0) return "it does nothing a mail rule can mirror"
  return matches.map((match) => ({
    match,
    action: hides ? "envelope" : "keep",
    ...(tags.length ? { tags } : {}),
    source: "gmail-filter",
    reason: match.subject
      ? "from a Gmail filter; Gmail searched these words anywhere, the rule matches the subject"
      : "from a Gmail filter",
    decided_at: decidedAt,
  }))
}

const nameOf = (raw: Raw, index: number) => {
  const criteria = (raw.criteria as Raw | undefined) ?? raw
  return text(criteria.query) ?? text(criteria.from) ?? text(criteria.subject) ?? text(raw.id) ?? `filter ${index + 1}`
}

/** The rules a Takeout Filters.json suggests; nothing is saved here. */
export const importFilters = (json: string, path: string, now = new Date()): FiltersProposal => {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new CliError("validation_error", `${path}: not JSON`, { reason: "mail.filters-file-invalid" })
  }
  const filters = Array.isArray(parsed) ? parsed : ((parsed as Raw | null)?.filters ?? (parsed as Raw | null)?.filter)
  if (!Array.isArray(filters))
    throw new CliError("validation_error", `${path}: no list of filters`, { reason: "mail.filters-file-invalid" })
  const proposal: FiltersProposal = { rules: [], skipped: [] }
  for (const [index, raw] of filters.entries()) {
    if (raw === null || typeof raw !== "object") continue
    const outcome = rulesOf(raw as Raw, now.toISOString())
    if (typeof outcome === "string") proposal.skipped.push({ filter: nameOf(raw as Raw, index), why: outcome })
    else for (const rule of outcome) proposal.rules.push(rule)
  }
  return proposal
}
