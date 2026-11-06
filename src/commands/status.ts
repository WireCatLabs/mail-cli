import { existsSync } from "node:fs"
import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { progressOf } from "@wirecat/cli-core/background"
import { answerEntity, answerLocally, baseContext, itemOf, LOCAL_READ, outputFor } from "@wirecat/cli-core/cli"
import { mailAccountKey, mailProgress, marksOf } from "@wirecat/cli-core/mail"
import { mailMark, markItem } from "@wirecat/cli-core/mail/cli"
import { Command } from "commander"
import * as v from "valibot"
import { configuration } from "../config.js"
import { IDENTITY } from "../identity.js"
import { openMailStore } from "../store.js"
import { contextOf } from "./context.js"

const nullableNumber = v.nullable(v.number())
const STALE_SCHEMA = /needs schema \d+ maintenance before a read-only open/

/** cli-core's `sync_progress` with the folders it adds up; that entity is strict, so this one is mail's own. */
const mailSyncStatus = v.strictObject({
  job: v.string(),
  profile: v.string(),
  done: v.number(),
  total: nullableNumber,
  remaining: nullableNumber,
  state: v.picklist(["partial", "complete"]),
  updated_at: v.nullable(v.string()),
  cursor_age_ms: nullableNumber,
  folders: v.array(
    v.strictObject({
      folder: v.string(),
      since: v.string(),
      done: v.number(),
      total: v.number(),
      updated_at: v.string(),
    }),
  ),
  /** How far each holder — an agent, a pipeline — processed this mailbox (`review --holder`). */
  holders: v.array(mailMark),
})

export const statusCommand = (): Command =>
  answerEntity(
    annotate(new Command("status"), {
      effects: LOCAL_READ,
      examples: [`${IDENTITY.command} personal status`, `${IDENTITY.command} personal status --json`],
    }),
    "mail_sync_status",
    mailSyncStatus,
  )
    .summary("how far the sync is, and how far each agent processed the mail")
    .description(
      "how many messages of the synced window are read and how many are left, per folder, and how far each holder " +
        "of a processing mark got and what it skipped; it asks no server, so it answers while a sync runs",
    )
    .action(async function (this: Command) {
      const context = contextOf(this)
      const address = context.settings.mailbox.address
      if (!address) throw new CliError("configuration_error", `profile ${context.profile} has no address`)
      const key = mailAccountKey(address)
      const { folders: report, holders } = await baseContext(this, configuration.resolveSettings).run(async () => {
        const { storePath } = await import("@wirecat/cli-core/store")
        if (!existsSync(storePath(context.env))) return { folders: [], holders: [] }
        // Read-only, so it answers while a sync holds the write lock. A store an older tool left at an older schema
        // refuses a read-only open, so status brings it up to date once, as the first sync after an upgrade would.
        const store = await openMailStore(context.env, { readOnly: true }).catch((error: unknown) => {
          if (error instanceof CliError && STALE_SCHEMA.test(error.message)) return openMailStore(context.env)
          throw error
        })
        context.environment.trackCloseable?.(store)
        try {
          const folders = (await mailProgress(store, key)).map(({ folder, since, done, total, updatedAt }) => ({
            folder,
            since,
            done,
            total,
            updated_at: updatedAt,
          }))
          return { folders, holders: await marksOf(store, key) }
        } finally {
          await store.close()
        }
      })
      const updatedAt = report
        .map(({ updated_at }) => updated_at)
        .sort()
        .at(-1)
      const progress = progressOf({
        job: "mail",
        profile: context.profile,
        done: report.reduce((sum, { done }) => sum + done, 0),
        ...(report.length ? { total: report.reduce((sum, { total }) => sum + total, 0) } : {}),
        ...(updatedAt === undefined ? {} : { updatedAt }),
      })
      answerLocally(this, outputFor(this), itemOf({ ...progress, folders: report, holders: holders.map(markItem) }))
    })
