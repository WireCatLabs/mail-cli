import { resolve } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import type { NextStep } from "@wirecat/cli-base/standards"
import {
  answerEntity,
  baseContext,
  environmentOf,
  FETCH,
  itemOf,
  outputFor,
  positiveCount,
  renderAnswer,
  runBudgetOf,
} from "@wirecat/cli-core/cli"
import { type Quick, searchMail } from "@wirecat/cli-core/mail"
import { refusedPlace } from "@wirecat/cli-core/sends"
import type { FolderEmail } from "@wirecat/cli-core/store"
import { Command, Option } from "commander"
import * as v from "valibot"
import { configuration } from "../config.js"
import type { ExportFormat } from "../export/format.js"
import { doneKey, openJournal } from "../export/journal.js"
import { type Written, writeBatch } from "../export/write.js"
import { IDENTITY } from "../identity.js"
import { DEFAULT_SYNC, providerFor } from "../providers.js"
import { openMailStore } from "../store.js"
import { contextOf, openMail, refuseOffline, repeatable } from "./context.js"
import { foldersFor } from "./sync.js"

const PAGE = 100
const FETCH_SLICE = 50

interface ExportFlags {
  format: ExportFormat
  output: string
  folder?: string[]
  limit?: number
  maxPages?: number
  resume?: boolean
  replace?: boolean
}

const mailExport = v.strictObject({
  address: v.string(),
  format: v.picklist(["mbox", "maildir"]),
  destination: v.string(),
  folders: v.array(v.string()),
  state: v.picklist(["partial", "complete"]),
  stopped: v.optional(v.picklist(["requests", "deadline", "cancelled", "limit"])),
  matched: v.number(),
  exported: v.number(),
  already_exported: v.number(),
  not_on_server: v.number(),
  unreadable: v.number(),
  complete: v.boolean(),
  hint: v.optional(v.string()),
})

interface Pending {
  folder: string
  validity: string
  email: FolderEmail
}

export const exportLeaf = (): Command =>
  answerEntity(
    annotate(new Command("export"), {
      effects: FETCH,
      cooperative: true,
      partial: true,
      examples: [
        `${IDENTITY.command} ya messages export 'from:ann@example.com' --output ~/mail-backup`,
        `${IDENTITY.command} ya messages export --folder INBOX --format maildir --output ~/Maildir`,
        `${IDENTITY.command} ya messages export 'date>30d' --limit 500 --output ~/mail-backup --resume`,
      ],
    }),
    "mail_export",
    mailExport,
  )
    .summary("write stored mail to mbox or Maildir files")
    .description(
      "copy the original messages of stored mail that match a query into mbox files (one per folder) or a Maildir++ " +
        "tree, for backup or for mu and notmuch. The store keeps text, not the original source, so each message is " +
        "read from the server again; the destination folder is private (mode 700, files 600)",
    )
    .argument("[query...]", "which stored mail: the same query as `search messages`; all of it if left out")
    .addOption(
      new Option("--format <format>", "mbox files or a Maildir++ tree").choices(["mbox", "maildir"]).default("mbox"),
    )
    .requiredOption(
      "--output <file>",
      "the folder to write the export into (not one file); made private if it does not exist",
    )
    .addOption(
      repeatable(
        "--folder <folder>",
        "only mail filed in this folder; repeat it for more (default: the folders sync reads)",
      ),
    )
    .option("--limit <n>", "write at most this many messages in this run, newest first", positiveCount("--limit"))
    .option(
      "--max-pages <pages>",
      "at most this many requests to the mail server in this run; as many as fit the deadline if not given",
      positiveCount("--max-pages"),
    )
    .option("--resume", "go on with the export already in the folder, skipping what it holds")
    .option("--replace", "write into a folder that has something in it, over files of the same name")
    .addHelpText(
      "after",
      "\nWhat is written: the original bytes of each message, in each folder it is filed in, with its read and starred " +
        "state in the Maildir file name. A message the server no longer has is counted as not_on_server, and one the " +
        "store has no UID for (sync again) the same way. Gmail files a message under All Mail and INBOX both: pass " +
        "--folder to export one. Without --resume or --replace a folder with something in it is refused.",
    )
    .action(async function (this: Command, query: string[], args: ExportFlags) {
      const context = contextOf(this)
      refuseOffline(context.flags)
      const address = context.settings.mailbox.address
      if (!address) throw new CliError("configuration_error", `profile ${context.profile} has no address`)
      if (args.resume && args.replace)
        throw new CliError("validation_error", "--resume and --replace cannot be used together", { param: "replace" })
      const destination = resolve(args.output)
      if (refusedPlace(destination, IDENTITY, context.env))
        throw new CliError(
          "validation_error",
          `will not export into ${args.output}: credential folders and the WireCat apps' folders are not written to`,
          { param: "output" },
        )
      const account = address.toLowerCase()
      const journal = await openJournal({
        path: destination,
        format: args.format,
        account,
        mode: args.resume ? "resume" : args.replace ? "replace" : "new",
      })
      const budget = runBudgetOf(this, args.maxPages)
      const { backend } = await openMail(context, { canRetry: () => budget.take() === null })
      try {
        const result = await baseContext(this, configuration.resolveSettings).run(async () => {
          const { mailbox } = context.settings
          const defaults = providerFor(address, mailbox.host)?.sync ?? DEFAULT_SYNC
          const folders = await foldersFor(args.folder, mailbox.folders, defaults, () => backend.folderList())
          const store = await openMailStore(context.env)
          environmentOf(this).trackCloseable?.(store)
          try {
            const stored = await store.accounts.storedAccount({ provider: "email", account }).catch(() => null)
            if (stored === null)
              throw new CliError(
                "not_found",
                `no mail is stored yet; run \`${IDENTITY.command} ${context.profile} sync\` first`,
              )
            const located = new Map<string, Map<string, Pending[]>>()
            for (const folder of folders) {
              const searched = await backend.search?.(new Date(0), folder)
              const validity = searched?.validity
              if (!validity) continue
              const byMessage = new Map<string, Pending[]>()
              for (const email of await store.mail.folderEmails(stored.id, folder, validity)) {
                const list = byMessage.get(email.externalId)
                const entry = { folder, validity, email }
                if (list) list.push(entry)
                else byMessage.set(email.externalId, [entry])
              }
              located.set(folder, byMessage)
            }

            let matched = 0
            let already = 0
            let absent = 0
            let unreadable = 0
            let exported = 0
            let stopped: "requests" | "deadline" | "cancelled" | "limit" | undefined
            let more = false
            let waiting: Pending[] = []
            const room = () =>
              args.limit === undefined ? Number.POSITIVE_INFINITY : args.limit - exported - waiting.length

            const flush = async (): Promise<boolean> => {
              while (waiting.length > 0) {
                const reason = budget.take()
                if (reason) {
                  stopped = reason
                  return false
                }
                const slice = waiting.slice(0, FETCH_SLICE)
                waiting = waiting.slice(FETCH_SLICE)
                const items: Quick[] = slice.map(({ folder, email }) => ({
                  uid: String(email.uid),
                  folder,
                  receivedAt: new Date(email.receivedAt ?? 0).toISOString(),
                }))
                const raws = await (
                  backend as { fetchRaw: (items: Quick[]) => Promise<(Uint8Array | Error)[]> }
                ).fetchRaw(items)
                const byFolder = new Map<string, Written[]>()
                for (const [at, entry] of slice.entries()) {
                  const raw = raws[at]
                  if (!(raw instanceof Uint8Array)) {
                    if (raw instanceof Error && (raw as { code?: string }).code === "not_found") absent++
                    else unreadable++
                    continue
                  }
                  const group = byFolder.get(entry.folder) ?? []
                  group.push({
                    folder: entry.folder,
                    validity: entry.validity,
                    uid: entry.email.uid,
                    receivedAt: entry.email.receivedAt,
                    read: entry.email.read,
                    flagged: entry.email.flagged,
                    raw,
                  })
                  byFolder.set(entry.folder, group)
                }
                for (const [folder, batch] of byFolder) {
                  await writeBatch(
                    args.format,
                    destination,
                    journal,
                    folder,
                    batch[0]?.validity as string,
                    batch,
                    Boolean(args.replace),
                  )
                  exported += batch.length
                }
              }
              return true
            }

            const text = query.join(" ")
            let offset = 0
            selecting: for (;;) {
              const page = text
                ? await searchMail(
                    store,
                    { provider: "email", account },
                    {
                      text,
                      limit: PAGE,
                      offset,
                      mailAccount: account,
                      newest: true,
                    },
                  )
                : await (async () => {
                    const rows = await store.mail.emails({ accountId: stored.id, limit: PAGE + 1, offset })
                    return {
                      items: rows.slice(0, PAGE).map(({ externalId }) => ({ id: externalId })),
                      hasMore: rows.length > PAGE,
                      nextOffset: offset + PAGE,
                    }
                  })()
              for (const hit of page.items) {
                matched++
                for (const folder of folders) {
                  for (const entry of located.get(folder)?.get(hit.id) ?? []) {
                    if (journal.done.has(doneKey(entry.folder, entry.validity, entry.email.uid))) {
                      already++
                      continue
                    }
                    if (room() <= 0) {
                      stopped = "limit"
                      more = true
                      break selecting
                    }
                    waiting.push(entry)
                  }
                }
                if (waiting.length >= FETCH_SLICE && !(await flush())) {
                  more = true
                  break selecting
                }
              }
              if (!page.hasMore) break
              offset = page.nextOffset ?? offset + PAGE
            }
            if ((stopped === undefined || stopped === "limit") && !(await flush())) more = true
            if (stopped) more = true
            return { folders, matched, already, absent, unreadable, exported, stopped, more, left: waiting.length }
          } finally {
            await store.close()
          }
        })
        const partial = result.more
        const next: NextStep[] = partial
          ? [
              {
                kind: "command",
                step: "mail.messages.export",
                command: "messages export",
                args: {
                  query: query.join(" ") || undefined,
                  format: args.format,
                  output: args.output,
                  resume: true,
                  ...(args.folder?.length ? { folder: args.folder } : {}),
                  ...(args.limit === undefined ? {} : { limit: args.limit }),
                },
                why:
                  result.stopped === "limit"
                    ? `the run wrote the ${args.limit} messages --limit allows; --resume writes the next ones`
                    : "the export stopped before its end to answer in time; --resume goes on from where it stopped",
                safe_to_auto_execute: false,
              },
            ]
          : []
        const hint = partial
          ? result.stopped === "limit"
            ? "more messages match; run it again with --resume to write the next ones"
            : "run it again with --resume to go on"
          : result.unreadable > 0
            ? `${result.unreadable} messages could not be read; --resume tries them again`
            : undefined
        const issues = [
          ...(result.unreadable > 0
            ? [{ code: "outcome_unknown" as const, reason: "mail.export-unreadable", source: "export" }]
            : []),
          ...(result.stopped && result.stopped !== "limit"
            ? [
                {
                  code: ({ requests: "rate_limited", deadline: "timeout", cancelled: "cancelled" } as const)[
                    result.stopped
                  ],
                  reason: `budget.${result.stopped}`,
                  source: "export",
                },
              ]
            : []),
        ]
        renderAnswer(
          this,
          outputFor(this),
          itemOf(
            {
              address: account,
              format: args.format,
              destination,
              folders: result.folders,
              state: partial ? "partial" : "complete",
              ...(result.stopped ? { stopped: result.stopped } : {}),
              matched: result.matched,
              exported: result.exported,
              already_exported: result.already,
              not_on_server: result.absent,
              unreadable: result.unreadable,
              complete: !partial && result.unreadable === 0,
              ...(hint ? { hint } : {}),
            },
            { next, meta: { complete: !partial && issues.length === 0, ...(issues.length ? { issues } : {}) } },
          ),
        )
      } finally {
        await backend.close()
      }
    })
