import { existsSync } from "node:fs"
import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { progressOf } from "@wirecat/cli-core/background"
import { baseContext, itemOf, LOCAL_READ, outputFor, renderAnswer } from "@wirecat/cli-core/cli"
import { parsePoint, type ResumePoint, resumeKey } from "@wirecat/cli-core/mail"
import { Command } from "commander"
import { configuration } from "../config.js"
import { IDENTITY } from "../identity.js"
import { openMailStore } from "../store.js"
import { contextOf } from "./context.js"

export const statusCommand = (): Command =>
  annotate(new Command("status"), {
    effects: LOCAL_READ,
    examples: [`${IDENTITY.command} ya status`, `${IDENTITY.command} ya status --json`],
  })
    .summary("how far the sync is, from what the runs saved")
    .description(
      "how many messages of the synced window are read and how many are left, per folder; it asks no server, so it answers while a sync runs",
    )
    .action(async function (this: Command) {
      const context = contextOf(this)
      const address = context.settings.mailbox.address
      if (!address) throw new CliError("configuration_error", `profile ${context.profile} has no address`)
      const key = { provider: "email", account: address.toLowerCase() }
      const report = await baseContext(this, configuration.resolveSettings).run(async () => {
        const { storePath } = await import("@wirecat/cli-core/store")
        if (!existsSync(storePath(context.env))) return []
        // Read-only, so it answers while a sync holds the write lock.
        const store = await openMailStore(context.env, { readOnly: true })
        try {
          const stored = await store.accounts.storedAccount(key).catch(() => null)
          const names =
            stored === null
              ? []
              : (await store.mail.mailboxes(stored.id))
                  .filter(({ kind }) => kind === null)
                  .map(({ externalId }) => externalId)
          const folders = []
          for (const folder of names) {
            const point = parsePoint<ResumePoint>((await store.sync.syncState(key, resumeKey(folder)))?.value)
            if (point !== undefined)
              folders.push({
                folder,
                since: point.window.since,
                done: point.window.done,
                total: point.window.total,
                updated_at: point.updatedAt,
              })
          }
          return folders
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
      renderAnswer(this, outputFor(this), itemOf({ ...progress, folders: report }))
    })
