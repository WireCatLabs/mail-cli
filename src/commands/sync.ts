import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { timezoneOf, zonedMoment } from "@wirecat/cli-base/query"
import type { NextStep } from "@wirecat/cli-base/standards"
import {
  answerEntity,
  baseContext,
  environmentOf,
  FETCH,
  itemOf,
  outputFor,
  renderAnswer,
  runBudgetOf,
} from "@wirecat/cli-core/cli"
import { type MailSyncResult, syncMail } from "@wirecat/cli-core/mail"
import { Command } from "commander"
import * as v from "valibot"
import { configuration } from "../config.js"
import { IDENTITY } from "../identity.js"
import { openMailStore } from "../store.js"
import { collect, contextOf, openSource, refuseOffline } from "./context.js"

const DAY_MS = 86_400_000
const DEFAULT_DAYS = 30

interface SyncFlags {
  sinceTime?: string
  limit?: number
  maxPages?: number
  folder?: string[]
  rescan?: boolean
}

/** A time without a zone is read in `zone`, and a date alone starts at its local midnight (WC-TIME-3, WC-TIME-5). */
const sinceOf = (value: string | undefined, zone: string, now: number): Date => {
  if (value === undefined) return new Date(now - DEFAULT_DAYS * DAY_MS)
  const refuse = () =>
    new CliError("validation_error", "--since-time takes an ISO date or timestamp in the past", {
      param: "since-time",
    })
  let since: number
  try {
    since = zonedMoment(value, zone, { start: 0, end: value.length })
  } catch (error) {
    if (error instanceof CliError) throw refuse()
    throw error
  }
  if (since > now) throw refuse()
  return new Date(since)
}

const BUDGET_CODES = { requests: "rate_limited", deadline: "timeout", cancelled: "cancelled" } as const

/** What the run left out, so `meta.complete` is false whenever any of it is there (WC-OUT-7). */
const issuesOf = (report: MailSyncResult) => [
  ...(report.unreadable?.length
    ? [{ code: "invalid_response" as const, reason: "mail.unreadable", source: "sync" }]
    : []),
  ...(report.deletionsSkipped
    ? [{ code: "outcome_unknown" as const, reason: "mail.deletions-skipped", source: "sync" }]
    : []),
  ...(report.stopped
    ? [{ code: BUDGET_CODES[report.stopped], reason: `budget.${report.stopped}`, source: "sync" }]
    : []),
]

const wholeNumberFor =
  (flag: string) =>
  (value: string): number => {
    if (!/^\d+$/.test(value.trim()) || Number(value) < 1)
      throw new CliError("validation_error", `--${flag} takes a whole number from 1 upwards, not "${value}"`, {
        param: flag,
      })
    return Number(value)
  }

/** INBOX and the folder the server marks as Sent, unless the profile or `--folder` says otherwise. */
const foldersFor = async (
  explicit: string[] | undefined,
  configured: string[] | undefined,
  list: () => Promise<{ path: string; role: string | null }[]>,
): Promise<string[]> => {
  if (explicit?.length) return explicit
  if (configured?.length) return configured
  const found = await list()
  const chosen = found
    .filter((folder) => folder.role === "inbox" || folder.role === "sent")
    .map((folder) => folder.path)
  return chosen.length ? chosen : ["INBOX"]
}

const mailSync = v.strictObject({
  address: v.string(),
  since: v.string(),
  timezone: v.string(),
  folders: v.array(v.string()),
  state: v.picklist(["partial", "complete"]),
  stopped: v.optional(v.picklist(["requests", "deadline", "cancelled", "limit"])),
  requests: v.number(),
  listed: v.number(),
  saved: v.number(),
  already_stored: v.number(),
  deleted: v.number(),
  complete: v.boolean(),
  remaining: v.number(),
  unreadable: v.number(),
  deletions_skipped: v.optional(v.string()),
  hint: v.optional(v.string()),
})

export const syncCommand = (): Command =>
  answerEntity(
    annotate(new Command("sync"), {
      effects: FETCH,
      // The run stops on its own before its deadline, keeps what it read and says how to go on (WC-LIFE-16).
      cooperative: true,
      partial: true,
      examples: [
        `${IDENTITY.command} ya sync`,
        `${IDENTITY.command} ya sync --since-time 2026-10-01 --limit 200`,
        `${IDENTITY.command} ya sync --folder INBOX`,
      ],
    }),
    "mail_sync",
    mailSync,
  )
    .description("read mail from the server into the shared store; mail already stored is skipped")
    .option(
      "--since-time <time>",
      "only mail received since this date or time; a date alone starts at local midnight, a time without a zone is local (default: 30 days)",
    )
    .option("--limit <n>", "save at most this many new emails in this run, newest first", wholeNumberFor("limit"))
    .option(
      "--max-pages <pages>",
      "at most this many requests to the mail server in this run; as many as fit the deadline if not given",
      wholeNumberFor("max-pages"),
    )
    .option(
      "--folder <folder>",
      "a folder to read; repeat it for more (default: the profile's folders, else INBOX and Sent)",
      collect,
    )
    .option("--rescan", "list every message in the window again, not only those an earlier run left")
    .action(async function (this: Command, args: SyncFlags) {
      const context = contextOf(this)
      refuseOffline(context.flags)
      const address = context.settings.mailbox.address
      if (!address) throw new CliError("configuration_error", `profile ${context.profile} has no address`)
      const zone = timezoneOf()
      const since = sinceOf(args.sinceTime, zone, Date.now())
      const { signal } = environmentOf(this)
      const budget = runBudgetOf(this, args.maxPages)
      // A retry is a request of the budget; openSource keeps it from ending after the deadline.
      const { source } = await openSource(context, { canRetry: () => budget.take() === null })
      try {
        const report = await baseContext(this, configuration.resolveSettings).run(async () => {
          const folders = await foldersFor(args.folder, context.settings.mailbox.folders, () => source.folderList())
          const store = await openMailStore(context.env)
          environmentOf(this).trackCloseable?.(store)
          try {
            return await syncMail(source, store, {
              account: { address, mode: "imap", folders },
              since,
              budget,
              ...(args.limit === undefined ? {} : { max: args.limit }),
              ...(args.rescan ? { rescan: true } : {}),
              ...(signal ? { signal } : {}),
            })
          } finally {
            await store.close()
          }
        })
        const issues = issuesOf(report)
        // cli-core reports a run its `max` cut short only as incomplete, with no reason and nothing remaining.
        const limited = args.limit !== undefined && !report.complete && !report.stopped && report.saved >= args.limit
        const stopped = report.stopped ?? (limited ? "limit" : undefined)
        const partial = (report.state ?? (report.complete ? "complete" : "partial")) === "partial" || limited
        const moved = report.saved + report.alreadyStored + report.skipped + report.envelopes > 0
        const timeout = this.optsWithGlobals<{ timeout?: string }>().timeout
        const next: NextStep[] =
          partial && moved
            ? [
                {
                  kind: "command",
                  step: "mail.sync",
                  command: "sync",
                  args: Object.fromEntries(
                    Object.entries({
                      since_time: args.sinceTime,
                      limit: args.limit,
                      max_pages: args.maxPages,
                      timeout,
                      folder: args.folder,
                    }).filter(([, value]) => value !== undefined),
                  ),
                  why: limited
                    ? `the run saved the ${args.limit} new emails --limit allows; running it again saves the next ones`
                    : "the sync stopped before its end to answer in time; running it again goes on from where it stopped",
                  safe_to_auto_execute: true,
                },
              ]
            : []
        const hint = !partial
          ? undefined
          : moved
            ? `run sync again to continue; ${IDENTITY.command} ${context.profile} status shows how far it is`
            : "this run moved nothing on: raise --timeout or --max-pages, then run sync again"
        renderAnswer(
          this,
          outputFor(this),
          itemOf(
            {
              address: report.account,
              since: report.since,
              timezone: zone,
              folders: report.coverage?.folders ?? [],
              state: partial ? "partial" : "complete",
              ...(stopped ? { stopped } : {}),
              requests: report.requests ?? 0,
              listed: report.listed,
              saved: report.saved,
              already_stored: report.alreadyStored,
              deleted: report.deleted,
              complete: report.complete,
              remaining: report.remaining ?? 0,
              unreadable: report.unreadable?.length ?? 0,
              ...(report.deletionsSkipped ? { deletions_skipped: report.deletionsSkipped } : {}),
              ...(hint ? { hint } : {}),
            },
            {
              next,
              meta: {
                complete: report.complete && issues.length === 0,
                ...(issues.length ? { issues } : {}),
                timezone: zone,
                window: { since: since.toISOString() },
              },
            },
          ),
        )
      } finally {
        await source.close()
      }
    })
