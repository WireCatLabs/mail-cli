import { CliError } from "@wirecat/cli-base"
import type { MailAction, MailRuleMatch } from "@wirecat/cli-core/mail"

export const FILTER_HELP =
  "from:<address, domain or word>, to:<address>, subject:<word> (or a bare word), older:<n>d, larger:<size> (5MB, 300KB), has:attachment, label:<name> " +
  '(label:"Two words"), is:unread, is:bulk, score:<n> (at least); all must hold'

const bad = (why: string) => new CliError("validation_error", `--filter: ${why}`)

const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** `from:` as Gmail reads it: one address, a whole domain (`shop.example`, `@shop.example`), or a word it contains. */
export const senderMatch = (value: string): MailRuleMatch => {
  if (ADDRESS.test(value)) return { from: value.toLowerCase() }
  const domain = value.replace(/^@/, "")
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(domain) ? { domain: domain.toLowerCase() } : { from_contains: value }
}

export const isAddress = (value: string) => ADDRESS.test(value)

const bytesOf = (value: string): number => {
  const match = /^(\d+(?:\.\d+)?)(b|kb|mb|gb)?$/i.exec(value)
  if (match === null) throw bad(`larger:${value} is not a size like 5MB, 300KB or 2048`)
  const unit = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[(match[2] ?? "b").toLowerCase() as "b"]
  return Math.round(Number(match[1]) * unit)
}

/** The conditions of a rule's --filter query. */
export const filterMatch = (query: string): MailRuleMatch => {
  const words: string[] = []
  const match: MailRuleMatch = {}
  for (const [, field, quoted, plain, word] of query.matchAll(/(\w+):(?:"([^"]*)"|(\S+))|(\S+)/g)) {
    const value = quoted ?? plain ?? ""
    if (word !== undefined) {
      words.push(word)
      continue
    }
    switch (field?.toLowerCase()) {
      case "from":
        Object.assign(match, senderMatch(value))
        break
      case "to":
        if (!ADDRESS.test(value)) throw bad(`to:${value} needs one address, like to:me@example.com`)
        match.to = value.toLowerCase()
        break
      case "subject":
        for (const part of value.split(/\s+/)) if (part) words.push(part)
        break
      case "older": {
        const days = /^(\d+)d$/i.exec(value)?.[1]
        if (days === undefined) throw bad(`older:${value} needs days, like older:365d`)
        match.older_than_days = Number(days)
        break
      }
      case "larger":
        match.larger_than_bytes = bytesOf(value)
        break
      case "has":
        if (!/^attachments?$/i.test(value)) throw bad(`has:${value}; only has:attachment is known`)
        match.has_attachments = true
        break
      case "label":
        match.label = value
        break
      case "is":
        if (/^unread$/i.test(value)) match.unread = true
        else if (/^bulk$/i.test(value)) match.bulk = true
        else throw bad(`is:${value}; is:unread and is:bulk are known`)
        break
      case "score":
        if (!/^-?\d+$/.test(value)) throw bad(`score:${value} needs a whole number`)
        match.score_at_least = Number(value)
        break
      default:
        throw bad(`${field}: is not a field; use ${FILTER_HELP}`)
    }
  }
  if (words.length) match.subject = words.join(" ")
  return match
}

export const ACTION_HELP =
  "one of skip (never read or store), envelope (store only sender, date, size and labels: counted, out of search, " +
  "cleanable later), keep (store in full even when a skip or envelope rule matches) or protect (keep, and no " +
  "cleanup may ever cut, archive or trash it); add tag:<name> to also tag the mail, e.g. envelope,tag:promo"

const ACTIONS = ["skip", "envelope", "keep", "protect"] as const

/** `envelope,tag:promo` → the store action, protection and tags. */
export const actionsOf = (value: string): { action: MailAction; protect: boolean; tags: string[] } => {
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
  const tags = parts.filter((part) => part.startsWith("tag:")).map((part) => part.slice(4).trim())
  const actions = parts.filter((part) => !part.startsWith("tag:"))
  if (tags.some((tag) => tag === "")) throw new CliError("validation_error", "--do: tag: needs a name, e.g. tag:promo")
  if (actions.length !== 1 || !(ACTIONS as readonly string[]).includes(actions[0] as string))
    throw new CliError("validation_error", `--do: choose ${ACTIONS.join(", ")}, plus any tag:<name>`)
  const action = actions[0] as (typeof ACTIONS)[number]
  return { action: action === "protect" ? "keep" : action, protect: action === "protect", tags }
}
