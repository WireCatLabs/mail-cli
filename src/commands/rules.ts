import { readFileSync } from "node:fs"
import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { type QueryRegistry, queryFieldsOf } from "@wirecat/cli-base/query"
import type { NextStep } from "@wirecat/cli-base/standards"
import {
  answerEntity,
  baseContext,
  dateWindow,
  grantsAuthority,
  itemOf,
  LOCAL_READ,
  LOCAL_WRITE,
  listOf,
  listQuery,
  outputFor,
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
  mapProposedTags,
  PRESET_NAMES,
  type PresetName,
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

const mailRule = v.looseObject({
  id: v.optional(v.number()),
  match: v.record(v.string(), v.unknown()),
  action: v.picklist(["keep", "envelope", "skip"]),
  tags: v.optional(v.array(v.string())),
  reason: v.optional(v.string()),
  protected: v.optional(v.boolean()),
  source: v.optional(v.string()),
  decided_at: v.string(),
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

const matchOf = (options: MatchOptions): MailRuleMatch => {
  const match: MailRuleMatch = {
    ...(options.sender === undefined ? {} : { from: options.sender }),
    ...(options.domain === undefined ? {} : { domain: options.domain }),
    ...(options.listId === undefined ? {} : { list_id: options.listId }),
    ...(options.filter === undefined ? {} : filterMatch(options.filter)),
    ...(options.kind === undefined ? {} : { preset: options.kind }),
  }
  if (conditionKeys(match).length === 0)
    throw new CliError("validation_error", "give at least one of --sender, --domain, --list-id, --filter, --kind")
  return match
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
    rule.tags_skipped ? `tags skipped: ${Object.keys(rule.tags_skipped).join(", ")}` : "",
    rule.source === undefined ? "" : `(${rule.source})`,
    rule.decided_at.slice(0, 10),
    rule.recorded === undefined ? "" : `${rule.recorded.emails} emails, ${megabytes(rule.recorded.bytes)} MB`,
    rule.reason ?? "",
  ]
    .filter(Boolean)
    .join("  ")
    .trimEnd()

const applyText = (result: ApplyResult): string =>
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
  ].join("\n")

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
        examples: [`${IDENTITY.command} ya rules list`, `${IDENTITY.command} ya rules list protected:true --json`],
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
      grantsAuthority(
        annotate(new Command("add"), {
          effects: LOCAL_WRITE,
          examples: [
            `${IDENTITY.command} ya rules add --domain shop.example --do envelope,tag:promo`,
            `${IDENTITY.command} ya rules add --sender boss@example.com --do protect --reason "never lose these"`,
            `${IDENTITY.command} ya rules add --filter "older:365d larger:5MB" --do envelope`,
          ],
        }),
      ),
    ),
    "mail_rule",
    mailRule,
  )
    .description("decide mail by sender, list, subject, age, size, label or kind; repeats replace")
    .requiredOption("--do <actions>", ACTION_HELP, actionsOf)
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
        "from that mail. has:attachment reads Content-Type at list time: a guess, not a parse.",
    )
    .action(async function (
      this: Command,
      options: MatchOptions & { do: ReturnType<typeof actionsOf>; reason?: string },
    ) {
      const rule: MailRule = {
        match: matchOf(options),
        action: options.do.action,
        ...(options.do.tags.length ? { tags: options.do.tags } : {}),
        ...(options.do.protect ? { protected: true } : {}),
        ...(options.kind === undefined ? {} : { source: `preset:${options.kind}` }),
        ...(options.reason === undefined ? {} : { reason: options.reason }),
        decided_at: new Date().toISOString(),
      }
      const saved = await withRules(this, (store, address) => saveRule(store, address, rule))
      renderAnswer(this, outputFor(this), itemOf(saved), () => ruleLine(saved))
    })

const removeCommand = () =>
  matchOptions(
    grantsAuthority(
      annotate(new Command("remove"), {
        effects: LOCAL_WRITE,
        examples: [
          `${IDENTITY.command} ya rules remove --domain shop.example`,
          `${IDENTITY.command} ya rules remove --filter "older:365d larger:5MB"`,
        ],
      }),
    ),
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

const applyCommand = () =>
  annotate(new Command("apply"), {
    effects: LOCAL_WRITE,
    examples: [
      `${IDENTITY.command} ya rules apply`,
      `${IDENTITY.command} ya rules apply --since-time 2026-01-01 --yes`,
    ],
  })
    .description("cut stored mail an envelope rule matches to its envelope; dry run unless --yes")
    .option("--since-time <time>", "only mail from this time, ISO 8601 or 30d ago (default: all mail)")
    .option("--dry-run", "only say what would change, even with --yes; the read-only lock lets this through")
    .addHelpText(
      "after",
      "\nWithout --yes it only says what would change. Reads the mailbox's headers from the server, from the folders sync reads (List-Id is not stored), then " +
        "drops the text, attachments and search entries of each matching stored email and keeps its sender, date, " +
        "size, labels and subject in metadata. Mail a skip rule matches is left as stored. Nothing changes in the " +
        "mailbox. Changing a rule to keep, or removing it, reads those emails in full on the next sync.",
    )
    .action(async function (this: Command, options: { sinceTime?: string; dryRun?: boolean }) {
      const context = contextOf(this)
      refuseOffline(context.flags)
      const address = addressOf(context)
      const window = dateWindow({ sinceTime: options.sinceTime })
      const since = new Date(window.since ?? 0)
      // --yes is the shared program's; it is read from the globals, as cli-core's own confirmed writes read it.
      const apply = this.optsWithGlobals<{ yes?: boolean }>().yes === true && options.dryRun !== true
      const { backend } = await openMail(context)
      try {
        const result = await withRules(this, async (store) =>
          applyRules({
            store,
            source: backend,
            account: { address, rules: await storedMailRules(store, { address }) },
            folders: await syncFoldersOf(context.settings.mailbox, backend),
            since,
            apply,
          }),
        )
        const next: NextStep[] =
          result.applied || result.envelopes + result.tagged === 0
            ? []
            : [
                {
                  kind: "command",
                  step: "mail.rules-apply",
                  command: "rules apply",
                  args: { yes: true, ...(options.sinceTime === undefined ? {} : { since_time: options.sinceTime }) },
                  why: "this was a dry run; --yes cuts them",
                  safe_to_auto_execute: false,
                },
              ]
        renderAnswer(this, outputFor(this), itemOf(snakeKeys(result), { next, meta: window.meta }), () =>
          applyText(result),
        )
      } finally {
        await backend.close()
      }
    })

const exportCommand = () =>
  annotate(new Command("export"), {
    effects: LOCAL_READ,
    examples: [`${IDENTITY.command} ya rules export`],
  })
    .description("print this mailbox's rules as JSON, to review, keep or move elsewhere")
    .addHelpText(
      "after",
      `\n${IDENTITY.command} ya rules export > rules.json; ${IDENTITY.command} ya rules import rules.json reads it ` +
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
  grantsAuthority(
    annotate(new Command("import"), {
      effects: LOCAL_WRITE,
      examples: [
        `${IDENTITY.command} ya rules import rules.json`,
        `${IDENTITY.command} ya rules import Filters.json --format gmail`,
        `${IDENTITY.command} ya rules import Filters.json --format gmail --yes`,
      ],
    }),
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
