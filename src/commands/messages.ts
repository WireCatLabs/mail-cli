import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { timezoneOf, zonedMoment } from "@wirecat/cli-base/query"
import { answerEntity, envName, REMOTE_WRITE } from "@wirecat/cli-core/cli"
import { decide, factsOf, listedOf, type MailRule, storedMailRules } from "@wirecat/cli-core/mail"
import { Command } from "commander"
import { IDENTITY } from "../identity.js"
import { CLEANUP_LIMIT, type Cleanup, cleanupOf } from "../mail/cleanup.js"
import { locate, selectIds } from "../mail/locate.js"
import { BULK, Changer, changeFlags, flagOf, moveMessages, targetOf, trashMessages, trashOf } from "../mail/organise.js"
import { contextOf, repeatable } from "./context.js"
import {
  type Action,
  answerChange,
  checkBulk,
  givenArgs,
  mailChange,
  type Opened,
  organising,
  type Planned,
  type Selection,
  selection,
  stringsOf,
  yesOf,
} from "./organising.js"
import { restoreCommand } from "./restore.js"

/** The shape of every flag and move command: select, locate, preview or change, answer. */
const organiseAction = (
  action: Action,
  key: string,
  describe: (
    opened: Opened,
    options: Selection & Record<string, unknown>,
  ) => Promise<{
    name: string
    to?: string
    everywhere?: boolean
    destructive?: boolean
    change: (changer: Changer, located: Planned["located"]["located"]) => Promise<string[]>
  }>,
) =>
  async function (this: Command, refs: string[], options: Selection & Record<string, unknown>) {
    await organising(this, async (opened) => {
      const plan = await describe(opened, options)
      const selected = await selectIds(opened.mailbox, {
        refs,
        ...(options.filter === undefined ? {} : { filter: options.filter }),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
      })
      const located = await locate(opened.mailbox, selected.ids, {
        everywhere: plan.everywhere === true,
        ...(plan.destructive ? { trash: await trashOf(opened.mailbox) } : {}),
      })
      const count = located.located.reduce((sum, { items }) => sum + items.length, 0)
      const bulk = options.filter !== undefined || count > BULK
      const preview = options.dryRun === true || ((bulk || plan.destructive === true) && !yesOf(this))
      const planned: Planned = { action: plan.name, selected, located, ...(plan.to ? { to: plan.to } : {}) }
      const given = givenArgs(refs, options)
      if (preview || count === 0) return answerChange(this, opened, planned, null, given)
      if (bulk) await checkBulk(opened.guard, count)
      const log = opened.log(action)
      const changer = new Changer(opened.mailbox, opened.guard, log, key, action)
      try {
        const changed = await plan.change(changer, located.located)
        answerChange(this, opened, planned, { run: log.run.id, changed, writes: changer.writes }, given)
      } finally {
        log.end(Date.now())
      }
    })
  }

const flagCommand = (
  name: string,
  summary: string,
  change: { add: string[]; remove: string[] },
  example: string,
): Command =>
  answerEntity(
    selection(
      annotate(new Command(name), {
        effects: REMOTE_WRITE,
        examples: [
          `${IDENTITY.command} personal messages ${name} ${example}`,
          `${IDENTITY.command} personal messages ${name} --filter 'from:shop@example.com is:unread' --yes`,
        ],
      }),
    ),
    "mail_change",
    mailChange,
  )
    .summary(summary)
    .description(`${summary}; on the server first, then in the store, so search shows it at once`)
    .action(
      organiseAction("message-flag", `messages.${name}`, async () => ({
        name,
        everywhere: true,
        change: (changer, located) => changeFlags(changer, located, change),
      })),
    )

const REF = "msg:email/me%40example.com/t1/m1"

const updateCommand = (): Command =>
  answerEntity(
    selection(
      annotate(new Command("update"), {
        effects: REMOTE_WRITE,
        examples: [
          `${IDENTITY.command} personal messages update ${REF} --flag answered --unflag '$Junk'`,
          `${IDENTITY.command} personal messages update ${REF} --flag read --flag flagged --replace`,
        ],
      }),
    ),
    "mail_change",
    mailChange,
  )
    .summary("set, unset or replace flags and keywords")
    .description(
      "set and unset flags (read, flagged, answered, draft) and keywords ($Forwarded, $Junk, words of your own); " +
        "--replace makes --flag each message's whole set",
    )
    .addOption(repeatable("--flag <flag>", "a flag or keyword to set; repeat it for more"))
    .addOption(repeatable("--unflag <flag>", "a flag or keyword to take away; repeat it for more"))
    .option("--replace", "--flag is the whole set: every other flag and keyword is taken away")
    .action(
      organiseAction("message-flag", "messages.update", async (_opened, options) => {
        const add = stringsOf(options.flag).map(flagOf)
        const remove = stringsOf(options.unflag).map(flagOf)
        if (options.replace && remove.length)
          throw new CliError("validation_error", "--replace takes --flag only: everything else is taken away")
        if (!options.replace && add.length === 0 && remove.length === 0)
          throw new CliError("validation_error", "give --flag or --unflag, or --replace with --flag")
        return {
          name: "update",
          everywhere: true,
          change: (changer, located) =>
            changeFlags(changer, located, { add, remove, replace: options.replace === true }),
        }
      }),
    )

const moveCommand = (op: "move" | "copy"): Command =>
  answerEntity(
    selection(
      annotate(new Command(op), {
        effects: REMOTE_WRITE,
        examples: [
          `${IDENTITY.command} personal messages ${op} ${REF} --folder Archive`,
          `${IDENTITY.command} personal messages ${op} --filter 'list:github.com date<2026-01-01' --folder Lists --yes`,
        ],
      }),
    ),
    "mail_change",
    mailChange,
  )
    .summary(op === "move" ? "move messages to another folder" : "copy messages to another folder")
    .description(
      op === "move"
        ? "move messages to a folder, by path, name or role (archive, junk, inbox); on Gmail, a label change that takes Inbox away"
        : "copy messages to a folder, by path, name or role; on Gmail, a label added",
    )
    .requiredOption("--folder <folder>", "the folder: its path, its name, or a role (archive, junk, inbox)")
    .action(
      organiseAction(op === "move" ? "message-move" : "message-copy", `messages.${op}`, async (opened, options) => {
        const target = await targetOf(opened.mailbox, String(options.folder), op === "copy")
        return {
          name: op,
          to: target.kind === "folder" ? target.path : target.name,
          change: (changer, located) => moveMessages(changer, located, target, op),
        }
      }),
    )

const sinceOf = (value: string | undefined) => {
  if (value === undefined) return undefined
  const since = zonedMoment(value, timezoneOf(), { start: 0, end: value.length })
  return new Date(since)
}

const cleanupAnswer = (cleanup: Cleanup) => ({
  envelopes: cleanup.envelopes,
  candidates: cleanup.candidates,
  bytes: cleanup.bytes,
  limit: cleanup.limit,
  first_run: cleanup.first_run,
  backup: cleanup.backup,
  rules: cleanup.rules.slice(0, 30),
})

const SYSTEM_LABEL = /^\\/

/** Gmail's labels and stars as they are now: what the owner starred or labelled since the last sync stays. */
const keptNow = (rules: Map<string, MailRule>) => (id: string, state: { flags: string[]; labels?: string[] }) => {
  const labels = state.labels ?? []
  if (state.flags.includes("\\Flagged") || labels.includes("\\Starred") || labels.includes("\\Important"))
    return "starred"
  const tags = rules.get(id)?.tags ?? []
  if (labels.some((label) => !SYSTEM_LABEL.test(label) && !tags.includes(label))) return "labelled"
  return undefined
}

const deleteCommand = (): Command =>
  answerEntity(
    selection(
      annotate(new Command("delete"), {
        effects: REMOTE_WRITE,
        examples: [
          `${IDENTITY.command} personal messages delete ${REF} --yes`,
          `${IDENTITY.command} personal messages delete --filter 'from:shop@example.com date<2025-01-01'`,
          `${IDENTITY.command} personal messages delete --rules --yes`,
        ],
      }),
      CLEANUP_LIMIT,
    ),
    "mail_change",
    mailChange,
  )
    .summary("move messages to Trash; messages restore brings them back")
    .description(
      "move messages to Trash, where the provider keeps them for a while (Gmail: 30 days) and messages restore brings them back; a preview unless --yes",
    )
    .option(
      "--rules",
      "the envelope mail the owner's rules let go, each decided again (`memo mail delete` did this before)",
    )
    .option("--since-time <time>", "with --rules, only mail received from this time; older mail stays")
    .addHelpText(
      "after",
      `
Nothing is expunged: mail goes to Trash and the run's record keeps where it was, its flags and its Gmail labels.
--rules moves only envelope mail, each email decided again with today's rules: it stays when a protect or keep
rule matches, you replied to the sender, it is starred, important, sent or a draft, it carries a label of yours, or
it is under 30 days old; Gmail's labels and stars are read again just before the move. It refuses until the store
backup is under 8 days old, and a first run moves at most 100, to check by hand. It refuses to run from a schedule.`,
    )
    .action(async function (
      this: Command,
      refs: string[],
      options: Selection & { rules?: boolean; sinceTime?: string },
    ) {
      if (options.rules && (refs.length || options.filter !== undefined))
        throw new CliError("validation_error", "--rules chooses the mail itself: give no references or --filter")
      if (options.sinceTime !== undefined && !options.rules)
        throw new CliError("validation_error", "--since-time goes with --rules", { param: "since-time" })
      const scheduled = envName(IDENTITY, "SCHEDULED")
      if (options.rules && contextOf(this).env[scheduled] !== undefined)
        throw new CliError(
          "permission_error",
          `messages delete --rules does not run from a schedule (${scheduled} is set): the owner checks each run by hand`,
          { reason: "mail.cleanup-scheduled" },
        )
      await organising(this, async (opened) => {
        const { mailbox } = opened
        const trash = await trashOf(mailbox)
        let cleanup: Cleanup | undefined
        let rulesOf = new Map<string, MailRule>()
        let selected: { ids: string[]; more: boolean }
        if (options.rules) {
          const rules = await storedMailRules(mailbox.store, { address: mailbox.key.account })
          const since = sinceOf(options.sinceTime)
          cleanup = await cleanupOf(mailbox, rules, {
            limit: options.limit ?? CLEANUP_LIMIT,
            env: opened.env,
            ...(since ? { since } : {}),
          })
          const facts = (await mailbox.store.mail.emailFacts({ accountId: mailbox.accountId })).map(listedOf)
          const factsFor = factsOf(facts, rules)
          rulesOf = new Map(
            facts.flatMap((item) => {
              const rule = decide(rules, factsFor(item))
              return rule && cleanup?.ids.includes(item.messageId) ? [[item.messageId, rule] as const] : []
            }),
          )
          selected = { ids: cleanup.ids, more: cleanup.candidates > cleanup.ids.length }
        } else
          selected = await selectIds(mailbox, {
            refs,
            ...(options.filter === undefined ? {} : { filter: options.filter }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
          })
        const located = await locate(mailbox, selected.ids, { trash })
        const count = located.located.reduce((sum, { items }) => sum + items.length, 0)
        const planned: Planned = {
          action: options.rules ? "delete by rules" : "delete",
          selected,
          located,
          to: trash,
          ...(cleanup ? { kept: cleanup.kept } : {}),
        }
        const given = {
          ...givenArgs(refs, options),
          ...(options.rules ? { rules: true } : {}),
          ...(options.sinceTime ? { since_time: options.sinceTime } : {}),
        }
        const preview = options.dryRun === true || !yesOf(this)
        const answer = (outcome: Parameters<typeof answerChange>[3]) =>
          answerChange(this, opened, planned, outcome, given, cleanup ? { cleanup: cleanupAnswer(cleanup) } : {})
        if (preview || count === 0) return answer(null)
        if (cleanup && !cleanup.backup.fresh)
          throw new CliError(
            "validation_error",
            cleanup.backup.at === null
              ? `no store backup is recorded at ${cleanup.backup.marker}; run the backup first`
              : `the newest store backup is from ${cleanup.backup.at}, older than 8 days; run the backup first`,
            { reason: "mail.archive-unverified" },
          )
        if (options.filter !== undefined || options.rules || count > BULK) await checkBulk(opened.guard, count)
        const log = opened.log("message-delete", {
          ...(options.rules ? { command: `${opened.line} --rules` } : {}),
          ...(mailbox.organise.labels ? { restorableUntil: new Date(Date.now() + 30 * 86_400_000).toISOString() } : {}),
        })
        const changer = new Changer(mailbox, opened.guard, log, "messages.delete", "message-delete")
        try {
          const { changed, kept } = await trashMessages(
            changer,
            located.located,
            trash,
            options.rules ? keptNow(rulesOf) : undefined,
          )
          answer({ run: log.run.id, changed, kept, writes: changer.writes })
        } finally {
          log.end(Date.now())
        }
      })
    })

/** The write commands of `messages`, mounted beside cli-core's `messages show`. */
export const messageWrites = (): Command[] => [
  flagCommand("mark-read", "mark messages read", { add: ["\\Seen"], remove: [] }, REF),
  flagCommand("mark-unread", "mark messages unread", { add: [], remove: ["\\Seen"] }, REF),
  flagCommand("star", "star messages (the \\Flagged flag)", { add: ["\\Flagged"], remove: [] }, REF),
  flagCommand("unstar", "take the star away", { add: [], remove: ["\\Flagged"] }, REF),
  updateCommand(),
  moveCommand("move"),
  moveCommand("copy"),
  deleteCommand(),
  restoreCommand(),
]
