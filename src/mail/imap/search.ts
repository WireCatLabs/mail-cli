import { CliError } from "@wirecat/cli-base"
import { type MailCriteria, SEARCH_REFUSED, type Searched } from "@wirecat/cli-core/mail"
import type { ImapFlow, SearchObject } from "imapflow"
import type { Connections } from "./connection.js"

/** How a provider's server is searched: Gmail's own syntax as X-GM-RAW, or RFC 3501 SEARCH keys. */
export type SearchSyntax = "gmail" | "imap"

const quoted = (value: string) => (/[\s"()]/.test(value) ? `"${value.replace(/"/g, " ").trim()}"` : value)

const gmailDay = (ms: number) => {
  const at = new Date(ms)
  return `${at.getUTCFullYear()}/${at.getUTCMonth() + 1}/${at.getUTCDate()}`
}

/**
 * Gmail's search operators (https://support.google.com/mail/answer/7190). Gmail has no body-only operator, so a
 * `body:` value is a plain word; `after:` and `before:` take days, which the criteria already widened.
 */
export const gmailRawOf = (criteria: MailCriteria): string =>
  [
    ...[...criteria.words, ...criteria.body].map(quoted),
    ...criteria.from.map((value) => `from:${quoted(value)}`),
    ...criteria.to.map((value) => `to:${quoted(value)}`),
    ...criteria.cc.map((value) => `cc:${quoted(value)}`),
    ...criteria.subject.map((value) => `subject:${quoted(value)}`),
    ...(criteria.since === undefined ? [] : [`after:${gmailDay(criteria.since)}`]),
    ...(criteria.before === undefined ? [] : [`before:${gmailDay(criteria.before)}`]),
    ...(criteria.seen === undefined ? [] : [criteria.seen ? "is:read" : "is:unread"]),
    ...(criteria.flagged ? ["is:starred"] : []),
  ].join(" ")

/**
 * One AND of every key. imapflow's query object holds each key once, so a second word or sender is nested in a
 * one-branch `or`, which imapflow sends as a parenthesised list: RFC 3501's AND of search keys.
 */
const allOf = ([first, ...rest]: SearchObject[]): SearchObject =>
  rest.length ? { ...first, or: [allOf(rest)] } : (first ?? {})

export const imapSearchOf = (criteria: MailCriteria): SearchObject =>
  allOf([
    ...criteria.words.map((text) => ({ text })),
    ...criteria.from.map((from) => ({ from })),
    ...criteria.to.map((to) => ({ to })),
    ...criteria.cc.map((cc) => ({ cc })),
    ...criteria.subject.map((subject) => ({ subject })),
    ...criteria.body.map((body) => ({ body })),
    ...(criteria.since === undefined ? [] : [{ since: new Date(criteria.since) }]),
    ...(criteria.before === undefined ? [] : [{ before: new Date(criteria.before) }]),
    ...(criteria.seen === undefined ? [] : [{ seen: criteria.seen }]),
    ...(criteria.flagged === undefined ? [] : [{ flagged: criteria.flagged }]),
  ])

/**
 * UID SEARCH of the open folder. imapflow resolves a NO or BAD as false; read as no match, it would make a folder
 * look empty: its stored mail proved deleted, a server search complete, a move acting on nothing.
 */
export const searchUids = async (open: ImapFlow, query: SearchObject, folder: string): Promise<number[]> => {
  const uids = await open.search(query, { uid: true })
  if (uids === false)
    throw new CliError("provider_error", `the mail server refused to search ${folder}`, { reason: SEARCH_REFUSED })
  return uids ?? []
}

/** The server's own search of one folder; nothing is marked read, since the folder opens read only. */
export const imapQuery =
  ({ inFolder, validities }: Connections) =>
  async (criteria: MailCriteria, folder: string, syntax: SearchSyntax): Promise<Searched> => {
    const query = syntax === "gmail" ? { gmraw: gmailRawOf(criteria) } : imapSearchOf(criteria)
    const found = await inFolder(folder, async (open, validity) => {
      const uids = await searchUids(open, query, folder)
      return { ...(validity ? { validity } : {}), uids: uids.map(String) }
    })
    if (found.validity) validities.set(folder, found.validity)
    return found
  }
