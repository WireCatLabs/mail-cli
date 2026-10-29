import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { baseContext, FETCH, itemOf, outputFor, renderAnswer } from "@wirecat/cli-core/cli"
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

const wholeNumber = (value: string): number => {
  if (!/^\d+$/.test(value.trim()) || Number(value) < 1)
    throw new CliError("validation_error", `--limit takes a whole number from 1 upwards, not "${value}"`, {
      param: "limit",
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
    // Without this a big mailbox is cut at the 30 s default; stored mail is kept and a rerun resumes.
    cooperative: true,
    examples: [
      `${IDENTITY.command} ya sync`,
      `${IDENTITY.command} ya sync --since-time 2026-10-01T00:00:00Z --limit 200`,
      `${IDENTITY.command} ya sync --folder INBOX`,
    ],
  })
    .description("read mail from the server into the shared store; mail already stored is skipped")
    .option("--since-time <time>", "only mail received since this ISO date or timestamp (default: 30 days)")
    .option("--limit <n>", "save at most this many new emails in this run, newest first", wholeNumber)
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
      const limit = args.limit
      const { source } = await openSource(context)
      try {
        const report = await baseContext(this, configuration.resolveSettings).run(async () => {
          const folders = await foldersFor(args.folder, context.settings.mailbox.folders, () => source.folderList())
          const store = await openMailStore(context.env)
          try {
            return await syncMail(source, store, {
              account: { address, mode: "imap", folders },
              since,
              ...(limit === undefined ? {} : { max: limit }),
              ...(args.rescan ? { rescan: true } : {}),
              ...(context.environment.signal ? { signal: context.environment.signal } : {}),
            })
          } finally {
            await store.close()
          }
        })
        renderAnswer(
          this,
          outputFor(this),
          itemOf({
            address: report.account,
            since: report.since,
            folders: report.coverage?.folders ?? [],
            listed: report.listed,
            saved: report.saved,
            already_stored: report.alreadyStored,
            deleted: report.deleted,
            complete: report.complete,
            unreadable: report.unreadable?.length ?? 0,
            ...(report.deletionsSkipped ? { deletions_skipped: report.deletionsSkipped } : {}),
          }),
        )
      } finally {
        await source.close()
      }
    })
