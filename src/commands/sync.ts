import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import type { NextStep } from "@wirecat/cli-base/standards"
import { baseContext, environmentOf, FETCH, itemOf, outputFor, renderAnswer, runBudgetOf } from "@wirecat/cli-core/cli"
import { syncMail } from "@wirecat/cli-core/mail"
import { Command } from "commander"
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

const sinceOf = (value: string | undefined, now: number): Date => {
  if (value === undefined) return new Date(now - DEFAULT_DAYS * DAY_MS)
  const since = new Date(value)
  if (Number.isNaN(since.getTime()) || since.getTime() > now)
    throw new CliError("validation_error", "--since-time takes an ISO date or timestamp in the past", {
      param: "since-time",
    })
  return since
}

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

export const syncCommand = (): Command =>
  annotate(new Command("sync"), {
    effects: FETCH,
    // The run stops on its own before its deadline, keeps what it read and says how to go on (WC-LIFE-16).
    cooperative: true,
    partial: true,
    examples: [
      `${IDENTITY.command} ya sync`,
      `${IDENTITY.command} ya sync --since-time 2026-10-01T00:00:00Z --limit 200`,
      `${IDENTITY.command} ya sync --folder INBOX`,
    ],
  })
    .description("read mail from the server into the shared store; mail already stored is skipped")
    .option("--since-time <time>", "only mail received since this ISO date or timestamp (default: 30 days)")
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
      const since = sinceOf(args.sinceTime, Date.now())
      const { signal } = environmentOf(this)
      const budget = runBudgetOf(this, args.maxPages)
      // A retry is a request of the budget; openSource keeps it from ending after the deadline.
      const { source } = await openSource(context, { canRetry: () => budget.take() === null })
      try {
        const report = await baseContext(this, configuration.resolveSettings).run(async () => {
          const folders = await foldersFor(args.folder, context.settings.mailbox.folders, () => source.folderList())
          const store = await openMailStore(context.env)
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
        const partial = report.state === "partial"
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
                  why: "the sync stopped before its end to answer in time; running it again goes on from where it stopped",
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
              folders: report.coverage?.folders ?? [],
              state: report.state ?? (report.complete ? "complete" : "partial"),
              ...(report.stopped ? { stopped: report.stopped } : {}),
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
            { next, meta: { complete: report.complete } },
          ),
        )
      } finally {
        await source.close()
      }
    })
