import { homedir } from "node:os"
import { resolve } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { timezoneOf } from "@wirecat/cli-base/query"
import {
  answerEntity,
  baseContext,
  environmentOf,
  itemOf,
  LOCAL_WRITE,
  outputFor,
  positiveCount,
  renderAnswer,
} from "@wirecat/cli-core/cli"
import { storedMailRuleSet, syncMail } from "@wirecat/cli-core/mail"
import { Command } from "commander"
import * as v from "valibot"
import { configuration } from "../config.js"
import { IDENTITY } from "../identity.js"
import { knownAges } from "../mail/domain-age.js"
import { mboxSource } from "../mail/mbox.js"
import { providerFor } from "../providers.js"
import { openMailStore } from "../store.js"
import { contextOf } from "./context.js"
import { sinceOf } from "./sync.js"

const mailImport = v.strictObject({
  address: v.string(),
  file: v.string(),
  since: v.string(),
  listed: v.number(),
  saved: v.number(),
  already_stored: v.number(),
  skipped: v.number(),
  envelopes: v.number(),
  unreadable: v.number(),
  complete: v.boolean(),
  remaining: v.number(),
  hint: v.optional(v.string()),
})

export const importLeaf = (): Command =>
  answerEntity(
    annotate(new Command("import"), {
      effects: LOCAL_WRITE,
      partial: true,
      examples: [
        `${IDENTITY.command} gm messages import ~/Takeout/Mail/All\\ mail\\ Including\\ Spam\\ and\\ Trash.mbox`,
        `${IDENTITY.command} gm messages import archive.mbox --since-time 2015-01-01 --limit 5000`,
      ],
    }),
    "mail_import",
    mailImport,
  )
    .summary("add the mail of a Google Takeout mbox file to the store")
    .description(
      "add the mail of a Gmail mbox file from Google Takeout to this Gmail profile's stored mail; Takeout keeps " +
        "Gmail's own ids, so an email both the file and sync bring is stored once. Only adds: mail missing from the " +
        "file is never marked deleted, Spam and Trash are left out, and the owner's rules skip what they skip. An " +
        "unchanged file read to the end is not read again",
    )
    .argument("<file>", "the .mbox file Google Takeout wrote")
    .option(
      "--since-time <time>",
      "only mail received since this date or time; a date alone starts at local midnight (default: the whole file)",
    )
    .option("--limit <n>", "save at most this many new emails in this run, newest first", positiveCount("--limit"))
    .action(async function (this: Command, file: string, args: { sinceTime?: string; limit?: number }) {
      const context = contextOf(this)
      const { address, host } = context.settings.mailbox
      if (!address) throw new CliError("configuration_error", `profile ${context.profile} has no address`)
      // Takeout's ids are Gmail's; under another provider's ids every email would be stored twice.
      if (providerFor(address, host)?.sync?.mode !== "gmail")
        throw new CliError(
          "validation_error",
          `profile ${context.profile} is not a Gmail mailbox; a Google Takeout mbox file joins only Gmail mail`,
          { param: "file" },
        )
      const path = resolve(file.replace(/^~(?=\/|$)/, context.env.HOME ?? homedir()))
      const since = args.sinceTime === undefined ? new Date(0) : sinceOf(args.sinceTime, timezoneOf(), Date.now())
      const { signal } = environmentOf(this)
      const report = await baseContext(this, configuration.resolveSettings).run(async () => {
        const store = await openMailStore(context.env)
        environmentOf(this).trackCloseable?.(store)
        try {
          const { rules } = await storedMailRuleSet(store, { address })
          return await syncMail(mboxSource(path), store, {
            account: { address, mode: "mbox", rules },
            since,
            ages: knownAges(context.env),
            ...(args.limit === undefined ? {} : { max: args.limit }),
            ...(signal ? { signal } : {}),
          })
        } finally {
          await store.close()
        }
      })
      const remaining = report.remaining ?? 0
      renderAnswer(
        this,
        outputFor(this),
        itemOf(
          {
            address: report.account,
            file: path,
            since: report.since,
            listed: report.listed,
            saved: report.saved,
            already_stored: report.alreadyStored,
            skipped: report.skipped,
            envelopes: report.envelopes,
            unreadable: report.unreadable?.length ?? 0,
            complete: report.complete,
            remaining,
            ...(report.complete ? {} : { hint: `${remaining} new emails are left; run the import again for the rest` }),
          },
          { meta: { complete: report.complete } },
        ),
      )
    })
