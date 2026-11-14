import { readFileSync } from "node:fs"
import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { type QueryRegistry, queryFieldsOf } from "@wirecat/cli-base/query"
import type { NextStep } from "@wirecat/cli-base/standards"
import { runBudget } from "@wirecat/cli-core/background"
import {
  answerEntity,
  baseContext,
  dateWindow,
  environmentOf,
  grantsAuthority,
  itemOf,
  LOCAL_READ,
  LOCAL_WRITE,
  listOf,
  listQuery,
  narrowsUnderLock,
  outputFor,
  readOnlyLockOf,
  readOnlyRefusal,
  renderAnswer,
  snakeKeys,
  typedQuery,
  withQuery,
} from "@wirecat/cli-core/cli"
import {
  conditionKeys,
  describeMatch,
  type MailRule,
  type MailRuleMatch,
  MEETING_NOTES,
  mailMeetingSource,
  mapProposedTags,
  PRESET_NAMES,
  type PresetName,
  ruleInput,
  saveMeetingNotes,
  storedMailRules,
} from "@wirecat/cli-core/mail"
import type { MessageStore } from "@wirecat/cli-core/store"
import { Command, Option } from "commander"
import * as v from "valibot"
import { configuration } from "../config.js"
import { IDENTITY } from "../identity.js"
import { type ApplyResult, applyRules } from "../mail/rules/apply.js"
import { type RulesFile, rulesFileOf } from "../mail/rules/file.js"
import { importFilters } from "../mail/rules/filters.js"
import { syncFoldersOf } from "../mail/rules/folders.js"
import { ACTION_HELP, actionsOf, FILTER_HELP, filterMatch } from "../mail/rules/query.js"
import { removeRule, ruleCounts, saveRule } from "../mail/rules/store.js"
import { openMailStore } from "../store.js"
import { contextOf, openMail, refuseOffline } from "./context.js"
import { flagParser, worded } from "./words.js"

const mailRule = v.looseObject({
  id: v.optional(v.number()),
  match: v.record(v.string(), v.unknown()),
  action: v.picklist(["keep", "envelope", "skip"]),
  tags: v.optional(v.array(v.string())),
  reason: v.optional(v.string()),
  protected: v.optional(v.boolean()),
  meeting_notes: v.optional(v.string()),
  source: v.optional(v.string()),
  decided_at: v.string(),
})

const mailRuleChange = v.looseObject({ removed: v.record(v.string(), v.unknown()) })

const mailRulesApply = v.looseObject({
  account: v.string(),
  applied: v.boolean(),
  listed: v.number(),
  envelopes: v.number(),
  bytes: v.number(),
  skip_matched: v.number(),
  protected_kept: v.number(),
  tagged: v.number(),
  state: v.picklist(["partial", "complete"]),
  stopped: v.optional(v.picklist(["requests", "deadline", "cancelled"])),
  cursor: v.optional(v.string()),
  rules: v.array(v.looseObject({})),
  meeting_notes: v.optional(v.record(v.string(), v.looseObject({ meetings: v.number() }))),
})

const gmailFiltersPreview = v.looseObject({
  rules: v.array(mailRule),
  skipped: v.array(v.looseObject({ filter: v.string(), why: v.string() })),
  tag_mapping: v.array(v.looseObject({ tag: v.string(), as: v.string(), why: v.string() })),
  added: v.number(),
})

const MAIL_RULES_QUERY: QueryRegistry = {
  entity: "mail_rule",
  backend: "sql",
  fields: queryFieldsOf(mailRule, {
    native: ["id", "protected", "source"],
    examples: { id: "id:1", protected: "protected:true", source: "source:owner" },
  }),
}

interface MatchOptions {
  sender?: string
  domain?: string
  listId?: string
  filter?: string
  kind?: PresetName
}

const matchOptions = (command: Command) =>
  command
    .option("--sender <address>", "one sender address")
    .option("--domain <domain>", "a sender domain, and its subdomains")
    .option("--list-id <id>", "a mailing list, by its List-Id")
    .option("--filter <query>", FILTER_HELP)
    .addOption(new Option("--kind <kind>", "a built-in kind of mail").choices(PRESET_NAMES))

const matchOf = (options: MatchOptions, meetingNotes?: string): MailRuleMatch => {
  const match: MailRuleMatch = {
    ...(options.sender === undefined ? {} : { from: options.sender }),
    ...(options.domain === undefined ? {} : { domain: options.domain }),
    ...(options.listId === undefined ? {} : { list_id: options.listId }),
    ...(options.filter === undefined ? {} : flagParser("--filter", filterMatch)(options.filter)),
    ...(options.kind === undefined ? {} : { preset: options.kind }),
  }
  const sender = meetingNotes === undefined ? undefined : MEETING_NOTES[meetingNotes]?.senders[0]
  if (conditionKeys(match).length === 0 && sender !== undefined) return { from: sender }
  if (conditionKeys(match).length === 0)
    throw new CliError("validation_error", "give at least one of --sender, --domain, --list-id, --filter, --kind")
  return match
}

/** Under `MAIL_READ_ONLY` (memo's scheduled triage) a rule only adds: one already there, perhaps the owner's, stays. */
const refuseReplacing = async (lock: string, match: MailRuleMatch, store: MessageStore, address: string) => {
  const same = JSON.stringify(ruleInput({ match, action: "skip", decided_at: "" }).conditions)
  const rules = await storedMailRules(store, { address })
  if (rules.some((rule) => JSON.stringify(ruleInput(rule).conditions) === same))
    throw readOnlyRefusal(lock, `replace the rule for ${describeMatch(match)}; the owner changes it`)
}

const megabytes = (bytes: number) => (bytes / 1024 / 1024).toFixed(1)

interface Recorded {
  emails: number
  bytes: number
}

const ruleLine = (rule: MailRule & { recorded?: Recorded }): string =>
  [
    rule.protected ? "PROTECTED" : rule.action.padEnd(8),
    describeMatch(rule.match),
    rule.tags?.length ? `tag ${rule.tags.join(", ")}` : "",
    rule.meeting_notes ? `${rule.meeting_notes} meeting notes` : "",
    rule.tags_skipped ? `tags skipped: ${Object.keys(rule.tags_skipped).join(", ")}` : "",
    rule.source === undefined ? "" : `(${rule.source})`,
    rule.decided_at.slice(0, 10),
    rule.recorded === undefined ? "" : `${rule.recorded.emails} emails, ${megabytes(rule.recorded.bytes)} MB`,
    rule.reason ?? "",
  ]
    .filter(Boolean)
    .join("  ")
    .trimEnd()

const applyText = (
  result: ApplyResult & { meetingNotes?: Record<string, { meetings: number }> },
  goOn: string | undefined,
): string =>
  [
    ...result.rules
      .filter(({ emails }) => emails > 0)
      .map(
        ({ rule, emails, bytes }) => `${describeMatch(rule.match)}  ${emails} emails, ${megabytes(bytes)} MB of text`,
      ),
    `${result.applied ? "cut" : "would cut"} ${result.envelopes} emails to envelopes, ` +
      `${megabytes(result.bytes)} MB of text, of ${result.listed} listed; ` +
      `${result.skipMatched} match only a skip rule and stay as stored; ` +
      `${result.protectedKept} are protected and stay whole; ${result.applied ? "tagged" : "would tag"} ${result.tagged}`,
    ...Object.entries(result.meetingNotes ?? {}).map(
      ([provider, { meetings }]) =>
        `${result.applied ? "saved" : "would save"} ${meetings} ${provider} meetings from notes`,
    ),
    ...(goOn === undefined ? [] : [`the run stopped before its time limit and kept what it did; to go on: ${goOn}`]),
  ].join("\n")

/** What a meeting-notes rule makes of mail stored before it: saved with --yes, counted without. */
const meetingNotesOf = async (
  store: MessageStore,
  address: string,
  rules: readonly MailRule[],
  since: Date,
  apply: boolean,
): Promise<Record<string, { meetings: number }> | undefined> => {
  const providers = [...new Set(rules.flatMap(({ meeting_notes }) => (meeting_notes ? [meeting_notes] : [])))]
  if (providers.length === 0) return undefined
  if (apply) {
    const reports = await saveMeetingNotes(store, address, rules, { since: since.toISOString() })
    return Object.fromEntries(Object.entries(reports).map(([provider, { meetings }]) => [provider, { meetings }]))
  }
  const counted: Record<string, { meetings: number }> = {}
  for (const provider of providers) {
    const source = mailMeetingSource({ store, meetings: store.meetings, address, rules, provider })
    counted[provider] = { meetings: (await source.meetings(since.toISOString())).length }
  }
  return counted
}

const addressOf = (context: ReturnType<typeof contextOf>): string => {
  const address = context.settings.mailbox.address
  if (!address)
    throw new CliError(
      "configuration_error",
      `profile ${context.profile} has no address; run \`${IDENTITY.command} ${context.profile} session start --address <email>\``,
    )
  return address
}

/** The profile's mailbox address and the shared store, open for `work` and closed after it. */
const withRules = <T>(
  command: Command,
  work: (store: MessageStore, address: string, context: ReturnType<typeof contextOf>) => Promise<T>,
): Promise<T> => {
  const context = contextOf(command)
  const address = addressOf(context)
  return baseContext(command, configuration.resolveSettings).run(async () => {
    const store = await openMailStore(context.env)
    context.environment.trackCloseable?.(store)
    try {
      return await work(store, address, context)
    } finally {
      await store.close()
    }
  })
}

const listCommand = () =>
  answerEntity(
    withQuery(
      annotate(new Command("list"), {
        effects: LOCAL_READ,
        examples: [
          `${IDENTITY.command} personal rules list`,
          `${IDENTITY.command} personal rules list protected:true --json`,
        ],
      }),
      MAIL_RULES_QUERY,
    ),
    "mail_rule",
    mailRule,
  )
    .description("this mailbox's rules, protected ones first")
    .addHelpText(
      "after",
      "\nProtected rules come first, as PROTECTED. An envelope rule shows how many emails it recorded and their " +
        "size at the source.",
    )
    .action(async function (this: Command, words: string[]) {
      const query = listQuery(typedQuery(words), MAIL_RULES_QUERY, "rules list")
      const items = await withRules(this, async (store, address) => {
        const rules = await storedMailRules(store, { address }, query)
        const counts = await ruleCounts(store, address)
        return rules
          .sort((a, b) => Number(b.protected === true) - Number(a.protected === true))
          .map((rule) => {
            const recorded = rule.id === undefined ? undefined : counts.get(rule.id)
            return rule.action === "envelope" ? { ...rule, recorded: recorded ?? { emails: 0, bytes: 0 } } : rule
          })
      })
      renderAnswer(
        this,
        outputFor(this),
        listOf("rules list", { items, limit: Math.max(1, items.length), has_more: false }),
        () => items.map(ruleLine).join("\n") || "no rules",
      )
    })

const addCommand = () =>
  answerEntity(
    matchOptions(
      narrowsUnderLock(
        grantsAuthority(
          annotate(new Command("add"), {
            effects: LOCAL_WRITE,
            examples: [
              `${IDENTITY.command} personal rules add --domain shop.example --do envelope,tag:promo`,
              `${IDENTITY.command} personal rules add --sender boss@example.com --do protect --reason "never lose these"`,
              `${IDENTITY.command} personal rules add --do meeting-notes:telemost`,
            ],
          }),
        ),
      ),
    ),
    "mail_rule",
    mailRule,
  )
    .description("decide mail by sender, list, subject, age, size, label or kind; repeats replace")
    .requiredOption("--do <actions>", ACTION_HELP, flagParser("--do", actionsOf))
    .option("--reason <text>", "why, for the owner later")
    .addHelpText(
      "after",
      "\nAll conditions given must hold. A protected rule wins over every other rule and kind; then keep wins over " +
        "envelope and envelope over skip, so --do keep --sender one sender overrides --do skip --domain of its " +
        "domain; an explicit rule wins over a --kind one. A skipped email is never read or stored by sync. An " +
        "envelope email costs no more from the mailbox than a skipped one; its subject is kept in its metadata, not " +
        "in search. Changing an envelope rule to keep, or removing it, reads those emails in full on the next sync. " +
        "Mail already stored in full stays; rules apply cuts or tags it.\n\n" +
        "score: and --kind judge a sender by its mail in the same listing; a sync that lists only new mail judges it " +
        "from that mail. has:attachment reads Content-Type at list time: a guess, not a parse.\n\n" +
        "Under MAIL_READ_ONLY, as in memo's scheduled mail triage, it takes only --sender or --list-id with " +
        "--do envelope, never replaces a rule, and records the rule with source agent.\n\n" +
        "--do meeting-notes:telemost, with no condition, matches the sender Telemost mails its notes from " +
        "(keeper@telemost.yandex.ru). Each email it matches is also saved as a meeting on sync; rules apply --yes " +
        "saves the ones stored before.",
    )
    .action(async function (
      this: Command,
      options: MatchOptions & { do: ReturnType<typeof actionsOf>; reason?: string },
    ) {
      const lock = readOnlyLockOf(IDENTITY, contextOf(this).env)
      const actions = options.do
      // A query, a kind or a domain could catch a whole mailbox, and skip or a tag decides more than how mail is
      // stored; the triage only files one sender or list as envelopes, which the owner can list and remove.
      if (lock && (options.filter !== undefined || options.kind !== undefined || options.domain !== undefined))
        throw readOnlyRefusal(lock, "add a rule by --filter, --kind or --domain; give --sender or --list-id")
      if (lock && (actions.action !== "envelope" || actions.protect || actions.tags.length > 0 || actions.meetingNotes))
        throw readOnlyRefusal(lock, "add a rule that does more than --do envelope")
      const match = matchOf(options, actions.meetingNotes)
      const rule: MailRule = {
        match,
        action: actions.action,
        ...(actions.tags.length ? { tags: actions.tags } : {}),
        ...(actions.protect ? { protected: true } : {}),
        ...(actions.meetingNotes === undefined ? {} : { meeting_notes: actions.meetingNotes }),
        ...(options.kind === undefined ? {} : { source: `preset:${options.kind}` }),
        ...(lock ? { source: "agent" } : {}),
        ...(options.reason === undefined ? {} : { reason: options.reason }),
        decided_at: new Date().toISOString(),
      }
      const saved = await withRules(this, async (store, address) => {
        if (lock) await refuseReplacing(lock, match, store, address)
        return saveRule(store, address, rule)
      })
      renderAnswer(this, outputFor(this), itemOf(saved), () => ruleLine(saved))
    })

const removeCommand = () =>
  answerEntity(
    matchOptions(
      grantsAuthority(
        annotate(new Command("remove"), {
          effects: LOCAL_WRITE,
          examples: [
            `${IDENTITY.command} personal rules remove --domain shop.example`,
            `${IDENTITY.command} personal rules remove --filter "older:365d larger:5MB"`,
          ],
        }),
      ),
    ),
    "mail_rule_change",
    mailRuleChange,
  )
    .description("drop the rule with exactly these conditions")
    .action(async function (this: Command, options: MatchOptions) {
      const match = matchOf(options)
      const { removed, profile } = await withRules(this, async (store, address, context) => ({
        removed: await removeRule(store, address, match),
        profile: context.profile,
      }))
      if (!removed)
        throw new CliError(
          "not_found",
          `no rule for ${describeMatch(match)}; \`${IDENTITY.command} ${profile} rules list\` shows them`,
          { reason: "mail.rule-not-found" },
        )
      renderAnswer(
        this,
        outputFor(this),
        itemOf({ removed: match }),
        () => `removed the rule for ${describeMatch(match)}`,
      )
    })

const STOP_CODES = { requests: "rate_limited", deadline: "timeout", cancelled: "cancelled" } as const

const applyCommand = () =>
  answerEntity(
    annotate(new Command("apply"), {
      effects: LOCAL_WRITE,
      // A large mailbox takes minutes to list; the run stops before its deadline, keeps what it did and gives a
      // --cursor to go on (WC-LIFE-10, WC-LIFE-16), so an MCP call answers before the client gives up.
      cooperative: true,
      partial: true,
      examples: [
        `${IDENTITY.command} personal rules apply`,
        `${IDENTITY.command} personal rules apply --since-time 2026-01-01 --yes`,
      ],
    }),
    "mail_rules_apply",
    mailRulesApply,
  )
    .description("cut stored mail an envelope rule matches to its envelope; dry run unless --yes")
    .option("--since-time <time>", "only mail from this time, ISO 8601 or 30d ago (default: all mail)")
    // Its own --yes, not only the program's: an MCP tool offers a command's own options, so an agent can apply.
    .option("--yes", "cut them; without it, only say what would change")
    .option("--dry-run", "only say what would change, even with --yes; the read-only lock lets this through")
    .option("--cursor <cursor>", "go on from where a stopped run ended; its next step gives it, with the same options")
    .addHelpText(
      "after",
      "\nWithout --yes it only says what would change. Reads the mailbox's headers from the server, newest first, from the folders sync reads (List-Id is not stored), then " +
        "drops the text, attachments and search entries of each matching stored email and keeps its sender, date, " +
        "size, labels and subject in metadata. Mail a skip rule matches is left as stored. Nothing changes in the " +
        "mailbox. Changing a rule to keep, or removing it, reads those emails in full on the next sync. A " +
        "meeting-notes rule saves the stored emails it matches as meetings.\n\n" +
        "A large mailbox takes minutes: 17,000 emails took about 4 minutes on one server. The run stops before its " +
        "time limit " +
        "(15 minutes, 45 seconds over MCP; --timeout changes it), keeps what it did and answers state partial with " +
        "a --cursor to go on. score: and --kind judge a sender by the mail this run has listed so far.",
    )
    .action(async function (this: Command, options: { sinceTime?: string; dryRun?: boolean; cursor?: string }) {
      const context = contextOf(this)
      refuseOffline(context.flags)
      const address = addressOf(context)
      const window = dateWindow({ sinceTime: options.sinceTime })
      const since = new Date(window.since ?? 0)
      const apply = this.optsWithGlobals<{ yes?: boolean }>().yes === true && options.dryRun !== true
      const { deadline, signal } = environmentOf(this)
      const ends = deadline?.()
      // Only the deadline and the slowest batch stop it, not a count of requests: a mailbox of 17,151 emails listed
      // about 70 headers a second (4 min 15 s), far more than the 60 in 9 s that requestMs assumes for a sync.
      const budget = runBudget({ requestMs: 1, ...(ends ? { deadline: ends } : {}), ...(signal ? { signal } : {}) })
      const { backend } = await openMail(context)
      let result: ApplyResult & { meetingNotes?: Record<string, { meetings: number }> }
      try {
        result = await worded(context.profile, () =>
          withRules(this, async (store) => {
            const rules = await storedMailRules(store, { address })
            const applied = await applyRules({
              store,
              source: backend,
              account: { address, rules },
              folders: await syncFoldersOf(context.settings.mailbox, backend),
              since,
              apply,
              ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
              take: () => budget.take(),
            })
            if (applied.stopped) return applied
            const meetingNotes = await meetingNotesOf(store, address, rules, since, apply)
            return meetingNotes === undefined ? applied : { ...applied, meetingNotes }
          }),
        )
      } finally {
        await backend.close()
      }
      const timeout = this.optsWithGlobals<{ timeout?: string }>().timeout
      const same = {
        ...(options.sinceTime === undefined ? {} : { since_time: options.sinceTime }),
        ...(timeout === undefined ? {} : { timeout }),
      }
      const changes =
        result.envelopes +
        result.tagged +
        Object.values(result.meetingNotes ?? {}).reduce((n, { meetings }) => n + meetings, 0)
      const next: NextStep[] =
        result.cursor !== undefined
          ? [
              {
                kind: "command",
                step: "mail.rules-apply",
                command: "rules apply",
                args: { ...same, ...(apply ? { yes: true } : {}), cursor: result.cursor },
                why:
                  result.listed === 0
                    ? "the run read nothing before its time limit; run it again with a longer --timeout"
                    : "the run stopped before its time limit to answer in time; this goes on from where it stopped",
                // The same decision, already made: only the stored copy changes, and the mailbox stays as it is.
                safe_to_auto_execute: true,
              },
            ]
          : result.applied || changes === 0
            ? []
            : [
                {
                  kind: "command",
                  step: "mail.rules-apply",
                  command: "rules apply",
                  args: { yes: true, ...same },
                  why: "this was a dry run; --yes cuts them",
                  safe_to_auto_execute: false,
                },
              ]
      const issues = result.stopped
        ? [{ code: STOP_CODES[result.stopped], reason: `budget.${result.stopped}`, source: "rules apply" }]
        : []
      const state = result.stopped ? "partial" : "complete"
      renderAnswer(
        this,
        outputFor(this),
        itemOf(snakeKeys({ ...result, state }), {
          next,
          meta: { ...window.meta, ...(issues.length ? { complete: false, issues } : {}) },
        }),
        () =>
          applyText(
            result,
            result.cursor === undefined
              ? undefined
              : [
                  `${IDENTITY.command} ${context.profile} rules apply`,
                  ...(apply ? ["--yes"] : []),
                  ...(options.sinceTime === undefined ? [] : [`--since-time ${options.sinceTime}`]),
                  ...(timeout === undefined ? [] : [`--timeout ${timeout}`]),
                  `--cursor ${result.cursor}`,
                ].join(" "),
          ),
      )
    })

const exportCommand = () =>
  annotate(new Command("export"), {
    effects: LOCAL_READ,
    examples: [`${IDENTITY.command} personal rules export`],
  })
    .description("print this mailbox's rules as JSON, to review, keep or move elsewhere")
    .addHelpText(
      "after",
      `\n${IDENTITY.command} personal rules export > rules.json; ${IDENTITY.command} personal rules import rules.json reads it ` +
        "back. memo mail rules import reads it too.",
    )
    .action(async function (this: Command) {
      const file = await withRules(this, async (store, address): Promise<RulesFile> => {
        const rules = await storedMailRules(store, { address })
        return { version: 1, account: address, rules: rules.map(({ id: _, ...rule }) => rule) }
      })
      outputFor(this).streams.data(`${JSON.stringify(file, null, 2)}\n`)
    })

const importCommand = () =>
  answerEntity(
    grantsAuthority(
      annotate(new Command("import"), {
        effects: LOCAL_WRITE,
        examples: [
          `${IDENTITY.command} personal rules import rules.json`,
          `${IDENTITY.command} personal rules import Filters.json --format gmail`,
          `${IDENTITY.command} personal rules import Filters.json --format gmail --yes`,
        ],
      }),
    ),
    "mail_rule_import",
    v.union([mailRule, gmailFiltersPreview]),
  )
    .summary("import saved rules, or preview Gmail filters")
    .description("import saved rules, or preview Gmail filters with --format gmail; same match replaces")
    .argument("<file>", "a rules JSON file from rules export, or Takeout Filters.json with --format gmail")
    .addOption(
      new Option("--format <format>", "the file's format: mail (memo's export is the same file) or gmail")
        .choices(["mail", "memo", "gmail"])
        .default("mail"),
    )
    .addHelpText(
      "after",
      "\nWith --format gmail it only previews the rules the filters suggest; --yes adds them. A rules file is " +
        "imported at once.",
    )
    .action(async function (this: Command, path: string, options: { format: "mail" | "memo" | "gmail" }) {
      const yes = this.optsWithGlobals<{ yes?: boolean }>().yes === true
      const text = readFileSync(path, "utf8")
      if (options.format === "gmail") {
        const parsed = importFilters(text, path)
        const { proposal, mapping, added, profile } = await withRules(this, async (store, address, context) => {
          const { rules: mapped, mapping } = await mapProposedTags(store, parsed.rules)
          const proposal = { ...parsed, rules: mapped }
          if (!yes) return { proposal, mapping, added: 0, profile: context.profile }
          for (const rule of proposal.rules) await saveRule(store, address, rule)
          return { proposal, mapping, added: proposal.rules.length, profile: context.profile }
        })
        renderAnswer(
          this,
          outputFor(this),
          itemOf({ rules: proposal.rules, skipped: proposal.skipped, tag_mapping: mapping, added }),
          () =>
            [
              ...proposal.rules.map(ruleLine),
              ...mapping.map(
                ({ tag, as, why }) => `label    ${tag} → ${as} (${why === "reuse" ? "same label" : "similar label"})`,
              ),
              ...proposal.skipped.map(({ filter, why }) => `skipped  ${filter}: ${why}`),
              yes
                ? `added ${added} rules`
                : `${proposal.rules.length} rules proposed; ` +
                  `\`${IDENTITY.command} ${profile} rules import ${path} --format gmail --yes\` adds them`,
            ].join("\n"),
        )
        return
      }
      const rules = rulesFileOf(text, path, `${IDENTITY.command} <profile> rules export`)
      const saved = await withRules(this, async (store, address) => {
        const out: MailRule[] = []
        for (const rule of rules) out.push(await saveRule(store, address, rule))
        return out
      })
      renderAnswer(
        this,
        outputFor(this),
        listOf("rules import", { items: saved, limit: Math.max(1, saved.length), has_more: false }),
        () => `imported ${saved.length} rules`,
      )
    })

export const rulesCommand = (): Command =>
  annotate(new Command("rules"), { effects: LOCAL_READ })
    .description("the owner's decisions on which mail to keep, record, skip, tag or protect")
    .addCommand(listCommand())
    .addCommand(addCommand())
    .addCommand(removeCommand())
    .addCommand(applyCommand())
    .addCommand(exportCommand())
    .addCommand(importCommand())
