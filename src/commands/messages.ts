import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { timezoneOf, zonedMoment } from "@wirecat/cli-base/query"
import type { NextStep } from "@wirecat/cli-base/standards"
import {
  answerEntity,
  baseContext,
  currentRun,
  envName,
  itemOf,
  outputFor,
  REMOTE_WRITE,
  renderAnswer,
  terminalAsker,
} from "@wirecat/cli-core/cli"
import { decide, factsOf, listedOf, type MailRule, storedMailRules } from "@wirecat/cli-core/mail"
import { type Asker, guardFor, type SendGuard } from "@wirecat/cli-core/sends"
import { Command } from "commander"
import * as v from "valibot"
import { configuration } from "../config.js"
import { IDENTITY } from "../identity.js"
import type { MailBackend } from "../mail/backend.js"
import { ChangeLog, readRun } from "../mail/changes.js"
import { CLEANUP_LIMIT, type Cleanup, cleanupOf } from "../mail/cleanup.js"
import {
  BULK,
  Changer,
  changeFlags,
  FILTER_LIMIT,
  flagOf,
  locate,
  MAX_LIMIT,
  type Mailbox,
  moveMessages,
  restoreRun,
  selectIds,
  targetOf,
  trashMessages,
  trashOf,
} from "../mail/organise.js"
import { DEFAULT_ORGANISE, providerFor } from "../providers.js"
import { openMailStore } from "../store.js"
import { collect, contextOf, openMail, refuseOffline } from "./context.js"

type Action = "message-flag" | "message-move" | "message-copy" | "message-delete" | "message-restore"

const BULK_KEY = "messages.bulk"

const mailChange = v.looseObject({
  action: v.string(),
  applied: v.boolean(),
  run: v.nullable(v.string()),
  selected: v.number(),
  located: v.number(),
  changed: v.number(),
  missing: v.number(),
  already_deleted: v.number(),
  in_trash: v.number(),
  more: v.boolean(),
  folders: v.array(v.strictObject({ folder: v.string(), messages: v.number() })),
  to: v.optional(v.string()),
  kept: v.optional(v.record(v.string(), v.number())),
  hint: v.optional(v.string()),
})

const mailRestore = v.looseObject({
  run: v.string(),
  applied: v.boolean(),
  restore_run: v.nullable(v.string()),
  command: v.string(),
  logged: v.number(),
  restorable: v.number(),
  missing: v.number(),
  restored: v.number(),
  expired: v.boolean(),
  restorable_until: v.nullable(v.string()),
})

const limitOf = (value: string) => {
  if (!/^\d+$/.test(value.trim()) || Number(value) < 1 || Number(value) > MAX_LIMIT)
    throw new CliError("validation_error", `--limit takes a whole number from 1 to ${MAX_LIMIT}`, { param: "limit" })
  return Number(value)
}

interface Selection {
  filter?: string
  limit?: number
  dryRun?: boolean
}

/** The y/N question once per key: a change made in several steps asks once. */
const askingOnce = (ask: Asker): Asker => {
  const answered = new Set<string>()
  return async (key, request) => {
    if (answered.has(key)) return
    await ask(key, request)
    answered.add(key)
  }
}

/**
 * The family asks `--allow-dangerous` before a deletion, which cannot be undone in a messenger. Mail's goes to Trash
 * and `messages restore` brings it back, so `--yes` answers it; `--allow-dangerous` stays for what is lost for good.
 */
const trashNeedsOnlyYes =
  (command: Command, ask: Asker): Asker =>
  async (key, request) => {
    if (key === "messages.delete" && command.optsWithGlobals<{ yes?: boolean }>().yes === true) return
    await ask(key, request)
  }

const commandLine = (command: Command, profile: string) => {
  const path: string[] = []
  for (let at: Command | null = command; at?.parent; at = at.parent) path.unshift(at.name())
  return { path: path.join(" "), line: `${IDENTITY.command} ${profile} ${path.join(" ")}` }
}

export interface Opened {
  mailbox: Mailbox
  backend: MailBackend
  guard: SendGuard
  log: (action: Action, extra?: { restorableUntil?: string; command?: string }) => ChangeLog
  profile: string
  env: NodeJS.ProcessEnv
  line: string
  path: string
}

/** Opens the store and the mailbox for one write command, and closes both after `work`. */
export const organising = async <T>(command: Command, work: (opened: Opened) => Promise<T>): Promise<T> => {
  const context = contextOf(command)
  refuseOffline(context.flags)
  const address = context.settings.mailbox.address
  if (!address) throw new CliError("configuration_error", `profile ${context.profile} has no address`)
  const { backend } = await openMail(context)
  try {
    return await baseContext(command, configuration.resolveSettings).run(async () => {
      const writes = backend.writes
      if (!writes) throw new CliError("provider_unavailable", "this mailbox cannot be changed from here")
      const store = await openMailStore(context.env)
      context.environment.trackCloseable?.(store)
      try {
        const key = { provider: "email", account: address.toLowerCase() }
        const stored = await store.accounts.storedAccount(key).catch(() => null)
        if (stored === null)
          throw new CliError(
            "not_found",
            `no mail of ${address} is stored yet; run \`${IDENTITY.command} ${context.profile} sync\` first`,
          )
        let folders: Awaited<ReturnType<typeof backend.folderList>> | undefined
        const mailbox: Mailbox = {
          app: IDENTITY,
          store,
          key,
          accountId: stored.id,
          writes,
          folders: async () => {
            folders ??= await backend.folderList()
            return folders
          },
          organise: providerFor(address, context.settings.mailbox.host)?.organise ?? DEFAULT_ORGANISE,
          now: Date.now,
        }
        // baseContext adds an MCP server's own --permission overrides, which a key checked only here would miss.
        const { settings } = baseContext(command, configuration.resolveSettings)
        const guard = guardFor(
          IDENTITY,
          { ...settings, permissionDefaults: configuration.permissions?.defaults ?? {} },
          (message) => outputFor(command).renderer.warn(message),
          context.env,
          askingOnce(trashNeedsOnlyYes(command, terminalAsker(command))),
        )
        const { path, line } = commandLine(command, context.profile)
        return await work({
          mailbox,
          backend,
          guard,
          profile: context.profile,
          env: context.env,
          path,
          line,
          log: (_action, extra = {}) =>
            new ChangeLog(context.env, {
              type: "run",
              id: currentRun().runId,
              account: key.account,
              command: extra.command ?? line,
              started_at: new Date().toISOString(),
              ...(extra.restorableUntil ? { restorable_until: extra.restorableUntil } : {}),
            }),
        })
      } finally {
        await store.close()
      }
    })
  } finally {
    await backend.close()
  }
}

/** A bulk change is checked as `messages.bulk` too, before anything is sent, so an owner can stop agents doing many. */
const checkBulk = async (guard: SendGuard, count: number) => {
  const probe = { chatId: null, kind: "read" as const, key: BULK_KEY, count }
  await guard.ask?.(probe)
  guard.check(probe, { reserve: false })
}

interface Planned {
  action: string
  selected: { ids: string[]; more: boolean }
  located: Awaited<ReturnType<typeof locate>>
  to?: string
  kept?: Record<string, number>
}

const restoreHint = (opened: Opened, run: string) =>
  `${IDENTITY.command} ${opened.profile} messages restore --run ${run} --yes undoes it`

/** Previews unless `--yes` (or always under `--dry-run`); a single small change that only flags or moves needs none. */
const answerChange = (
  command: Command,
  opened: Opened,
  plan: Planned,
  outcome: { run: string; changed: string[]; kept?: Record<string, number> } | null,
  given: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => {
  const { located, selected } = plan
  const folders = located.located.map(({ folder, items }) => ({ folder, messages: items.length }))
  const count = located.located.reduce((sum, { items }) => sum + items.length, 0)
  const kept = { ...plan.kept, ...outcome?.kept }
  const next: NextStep[] = outcome
    ? [
        {
          kind: "command",
          step: "mail.restore",
          command: "messages restore",
          args: { run: outcome.run },
          why: "puts back what this run changed, while the server still holds it",
          safe_to_auto_execute: false,
        },
      ]
    : count > 0
      ? [
          {
            kind: "command",
            step: "mail.apply",
            command: opened.path,
            args: { ...given, yes: true },
            why: "this was a preview; the same command with --yes makes the change",
            safe_to_auto_execute: false,
          },
        ]
      : []
  renderAnswer(
    command,
    outputFor(command),
    itemOf(
      {
        action: plan.action,
        applied: outcome !== null,
        run: outcome?.run ?? null,
        selected: selected.ids.length,
        located: count,
        changed: outcome?.changed.length ?? 0,
        missing: located.missing.length,
        already_deleted: located.deleted.length,
        in_trash: located.inTrash.length,
        more: selected.more,
        folders,
        ...(plan.to ? { to: plan.to } : {}),
        ...(Object.keys(kept).length ? { kept } : {}),
        ...extra,
        ...(outcome
          ? { hint: restoreHint(opened, outcome.run) }
          : count > 0
            ? { hint: `a preview: nothing changed; add --yes to change ${count}` }
            : {}),
      },
      { next },
    ),
  )
}

const selection = (command: Command, max = FILTER_LIMIT) =>
  command
    .argument("[message...]", "msg:email/… references, as search messages shows them")
    .option("--filter <query>", "the stored mail this query finds, instead of references (search messages syntax)")
    .option(
      "--limit <n>",
      `with --filter, at most this many, newest first (default ${max}, at most ${MAX_LIMIT})`,
      limitOf,
    )
    .option("--yes", "make the change; a deletion or a change of many is only a preview without it")
    .option("--dry-run", "only preview what would change, even with --yes")

const yesOf = (command: Command) => command.optsWithGlobals<{ yes?: boolean }>().yes === true

const givenArgs = (refs: string[], options: Selection) => ({
  ...(refs.length ? { message: refs } : {}),
  ...(options.filter === undefined ? {} : { filter: options.filter }),
  ...(options.limit === undefined ? {} : { limit: options.limit }),
})

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
        answerChange(this, opened, planned, { run: log.run.id, changed }, given)
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
          `${IDENTITY.command} ya messages ${name} ${example}`,
          `${IDENTITY.command} ya messages ${name} --filter 'from:shop@example.com is:unread' --yes`,
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
          `${IDENTITY.command} ya messages update ${REF} --flag answered --unflag '$Junk'`,
          `${IDENTITY.command} ya messages update ${REF} --flag read --flag flagged --replace`,
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
    .option("--flag <flag>", "a flag or keyword to set; repeat it for more", collect)
    .option("--unflag <flag>", "a flag or keyword to take away; repeat it for more", collect)
    .option("--replace", "--flag is the whole set: every other flag and keyword is taken away")
    .action(
      organiseAction("message-flag", "messages.update", async (_opened, options) => {
        const add = ((options.flag as string[] | undefined) ?? []).map(flagOf)
        const remove = ((options.unflag as string[] | undefined) ?? []).map(flagOf)
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
          `${IDENTITY.command} ya messages ${op} ${REF} --folder Archive`,
          `${IDENTITY.command} ya messages ${op} --filter 'list:github.com date<2026-01-01' --folder Lists --yes`,
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
          `${IDENTITY.command} ya messages delete ${REF} --yes`,
          `${IDENTITY.command} ya messages delete --filter 'from:shop@example.com date<2025-01-01'`,
          `${IDENTITY.command} ya messages delete --rules --yes`,
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
    .option("--rules", "the envelope mail the owner's rules let go, each decided again (memo's mail delete)")
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
          ...(cleanup ? { kept: cleanup.kept as Record<string, number> } : {}),
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
          answer({ run: log.run.id, changed, kept })
        } finally {
          log.end(Date.now())
        }
      })
    })

const restoreCommand = (): Command =>
  answerEntity(
    annotate(new Command("restore"), {
      effects: REMOTE_WRITE,
      examples: [
        `${IDENTITY.command} ya messages restore --run 20261101T101500Z-messages-delete-1a2b3c`,
        `${IDENTITY.command} ya messages restore --run 20261101T101500Z-messages-delete-1a2b3c --yes`,
      ],
    }),
    "mail_restore",
    mailRestore,
  )
    .summary("undo a run of messages delete, move, copy or a flag change")
    .description(
      "undo a change run, last step first, for the messages still where it left them: Trash back to where they were, " +
        "moves back, copies removed, flags as they were; a preview unless --yes",
    )
    .requiredOption("--run <id>", "the run id a change answered with (runs list shows recent runs)")
    .option("--yes", "make the change; without it, only say what would come back")
    .option("--dry-run", "only preview, even with --yes")
    .addHelpText(
      "after",
      `
memo's mail delete runs restore here too, by their id. Mail Gmail has emptied from Trash (30 days) cannot come back.
Envelopes come back to search at once; mail with text is saved again by the next sync.`,
    )
    .action(async function (this: Command, options: { run: string; dryRun?: boolean }) {
      await organising(this, async (opened) => {
        const found = readRun(opened.env, opened.mailbox.key.account, options.run)
        const apply = options.dryRun !== true && yesOf(this)
        const log = apply ? opened.log("message-restore") : undefined
        const changer = new Changer(
          opened.mailbox,
          opened.guard,
          log ?? ({ begin: () => 0, done: () => {}, run: { id: "" } } as unknown as ChangeLog),
          "messages.restore",
          "message-restore",
        )
        try {
          const plan = await restoreRun(changer, found.run, found.path, apply)
          const next: NextStep[] = apply
            ? plan.restored > 0
              ? [
                  {
                    kind: "command",
                    step: "mail.sync",
                    command: "sync",
                    args: {},
                    why: "mail with text comes back to search when sync saves it again",
                    safe_to_auto_execute: true,
                  },
                ]
              : []
            : plan.restorable > 0
              ? [
                  {
                    kind: "command",
                    step: "mail.apply",
                    command: "messages restore",
                    args: { run: options.run, yes: true },
                    why: "this was a preview; --yes moves them back",
                    safe_to_auto_execute: false,
                  },
                ]
              : []
          renderAnswer(
            this,
            outputFor(this),
            itemOf(
              {
                run: plan.run,
                applied: apply,
                restore_run: log?.run.id ?? null,
                command: plan.command,
                logged: plan.logged,
                restorable: plan.restorable,
                missing: plan.missing,
                restored: plan.restored,
                expired: plan.expired,
                restorable_until: plan.restorable_until,
              },
              { next },
            ),
          )
        } finally {
          log?.end(Date.now())
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
