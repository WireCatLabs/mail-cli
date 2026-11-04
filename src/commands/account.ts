import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { timezoneOf } from "@wirecat/cli-base/query"
import {
  answerEntity,
  baseContext,
  itemOf,
  LOCAL_READ,
  outputFor,
  positiveCount,
  REMOTE_READ,
  renderAnswer,
} from "@wirecat/cli-core/cli"
import {
  domainsToAge,
  FREE_MAIL,
  type Listed,
  type Probe,
  probeMail,
  SCORE_RULE,
  SUGGEST_RULE,
} from "@wirecat/cli-core/mail"
import { Command } from "commander"
import * as v from "valibot"
import { configuration } from "../config.js"
import { IDENTITY } from "../identity.js"
import { knownAges, lookUpAges, rdapDeps } from "../mail/domain-age.js"
import { DEFAULT_SYNC, providerFor } from "../providers.js"
import { PASSWORD_SOURCES } from "../secret.js"
import { contextOf, openMail, refuseOffline, repeatable } from "./context.js"
import { foldersFor, sinceOf } from "./sync.js"

const mailAccountCheck = v.strictObject({
  profile: v.string(),
  host: v.string(),
  port: v.number(),
  security: v.picklist(["tls", "starttls", "plain"]),
  password_from: v.picklist(PASSWORD_SOURCES),
  login: v.string(),
  capabilities: v.array(v.string()),
  features: v.record(v.string(), v.boolean()),
  folders: v.number(),
})

const checkCommand = () =>
  answerEntity(
    annotate(new Command("check"), {
      effects: REMOTE_READ,
      examples: [`${IDENTITY.command} ya account check`, `${IDENTITY.command} ya account check --json`],
    }),
    "mail_account_check",
    mailAccountCheck,
  )
    .summary("log in and list what the server supports")
    .description("log in to the server and list what it supports (IDLE, CONDSTORE, MOVE, Gmail extensions)")
    .action(async function (this: Command) {
      const context = contextOf(this)
      refuseOffline(context.flags)
      const { backend, endpoint, passwordFrom } = await openMail(context)
      try {
        const checked = await baseContext(this, configuration.resolveSettings).run(() => backend.check())
        renderAnswer(
          this,
          outputFor(this),
          itemOf({
            profile: context.profile,
            host: endpoint.host,
            port: endpoint.port,
            security: endpoint.security,
            password_from: passwordFrom,
            ...checked,
          }),
        )
      } finally {
        await backend.close()
      }
    })

const mailAccountInspect = v.strictObject({
  address: v.string(),
  folders: v.array(v.string()),
  emails: v.number(),
  bytes: v.number(),
  sent: v.number(),
  without_headers: v.number(),
  groups: v.number(),
  items: v.array(
    v.strictObject({
      from: v.nullable(v.string()),
      list_id: v.nullable(v.string()),
      emails: v.number(),
      bytes: v.number(),
      unread: v.nullable(v.number()),
      bulk: v.number(),
      first_year: v.number(),
      last_year: v.number(),
      replied: v.boolean(),
      suggest: v.nullable(v.literal("skip")),
      score: v.number(),
      signals: v.array(v.string()),
      untrusted: v.array(v.string()),
    }),
  ),
  presets: v.array(v.strictObject({ preset: v.string(), emails: v.number(), groups: v.number(), bytes: v.number() })),
  domain_lookups: v.optional(v.strictObject({ looked: v.number(), failed: v.number() })),
  seconds: v.number(),
})

const megabytes = (bytes: number) => (bytes / 1024 / 1024).toFixed(1)
const percent = (value: number | null) => (value === null ? "?" : `${Math.round(value * 100)}%`)

const probeText = (probe: Probe, seconds: number): string => {
  const rows = probe.items.map((group) => [
    String(group.emails),
    megabytes(group.bytes),
    percent(group.unread),
    percent(group.bulk),
    group.firstYear === group.lastYear ? String(group.firstYear) : `${group.firstYear}-${group.lastYear}`,
    group.replied ? "yes" : "no",
    group.suggest ?? "",
    String(group.score),
    group.listId === null ? (group.from ?? "") : `${group.listId} (${group.from ?? "?"})`,
  ])
  const header = ["emails", "MB", "unread", "bulk", "years", "replied", "suggest", "score", "sender or list"]
  const widths = header.map((title, column) =>
    rows.reduce((widest, row) => Math.max(widest, row[column]?.length ?? 0), title.length),
  )
  const line = (row: string[]) =>
    row
      .map((cell, column) => (column < 2 ? cell.padStart(widths[column] ?? 0) : cell.padEnd(widths[column] ?? 0)))
      .join("  ")
      .trimEnd()
  return `${[
    `${probe.emails} emails, ${megabytes(probe.bytes)} MB, ${probe.groups} groups; ${probe.sent} sent, ` +
      `${probe.withoutHeaders} without readable headers; ${seconds}s`,
    line(header),
    ...rows.map(line),
    ...(probe.presets.length
      ? [
          "",
          `kinds this mail would match (${IDENTITY.command} <profile> rules add --kind <kind> --do envelope):`,
          ...probe.presets.map(
            ({ preset, emails, groups, bytes }) =>
              `  ${preset.padEnd(12)}${emails} emails, ${groups} groups, ${megabytes(bytes)} MB`,
          ),
        ]
      : []),
  ].join("\n")}\n`
}

interface InspectFlags {
  sinceTime?: string
  limit: number
  folder?: string[]
  domainAge?: boolean
}

const inspectCommand = () =>
  answerEntity(
    annotate(new Command("inspect"), {
      effects: REMOTE_READ,
      examples: [
        `${IDENTITY.command} gm account inspect`,
        `${IDENTITY.command} gm account inspect --since-time 2025-01-01 --limit 20 --domain-age`,
      ],
    }),
    "mail_account_inspect",
    mailAccountInspect,
  )
    .summary("group the mailbox's mail by sender and list, to decide what to keep")
    .description(
      "read the headers of the mailbox's mail, store nothing, and group it by mailing list or sender, the largest " +
        `group first; each group's ${SUGGEST_RULE}. Its ${SCORE_RULE}. The owner decides; rules add adds a rule`,
    )
    .option(
      "--since-time <time>",
      "only mail received since this date or time; a date alone starts at local midnight (default: all mail)",
    )
    .option("--limit <n>", "show this many of the largest groups", positiveCount("--limit"), 50)
    .addOption(
      repeatable(
        "--folder <folder>",
        "a folder to read; repeat it for more (default: the profile's folders, else INBOX and Sent; All Mail on Gmail)",
      ),
    )
    .option(
      "--domain-age",
      "ask each shown sender domain's registry when it was registered (RDAP); tells each registry its domain",
    )
    .addHelpText(
      "after",
      "\nHeaders only: about 1 KB per email (From, To, Cc, Reply-To, List-Id, List-Unsubscribe, Precedence and " +
        "Gmail's SPF, DKIM and DMARC verdicts), counted against Gmail's daily download limit.\n\n" +
        "--domain-age asks the registry of each shown group's sender domain, one a second, and keeps the answer on " +
        "this computer for good. Big mailbox providers and senders the owner replied to are never asked; most " +
        "country domains (.ru, .de, .es, .io) have no RDAP and stay unknown. Without it, only ages already kept are " +
        "used and nothing but the mail server is asked.",
    )
    .action(async function (this: Command, args: InspectFlags) {
      const context = contextOf(this)
      refuseOffline(context.flags)
      const { address, host, folders: configured } = context.settings.mailbox
      if (!address) throw new CliError("configuration_error", `profile ${context.profile} has no address`)
      const since = args.sinceTime === undefined ? new Date(0) : sinceOf(args.sinceTime, timezoneOf(), Date.now())
      const started = Date.now()
      const { backend } = await openMail(context)
      try {
        const { folders, items } = await baseContext(this, configuration.resolveSettings).run(async () => {
          const defaults = providerFor(address, host)?.sync ?? DEFAULT_SYNC
          const folders = await foldersFor(args.folder, configured, defaults, () => backend.folderList())
          const listed = new Map<string, Listed>()
          for (const folder of folders)
            for (const item of await backend.list(since, folder, { headers: true })) listed.set(item.messageId, item)
          return { folders, items: [...listed.values()] }
        })
        let probe = probeMail(items, args.limit, knownAges(context.env))
        let lookups: { looked: number; failed: number } | undefined
        if (args.domainAge) {
          lookups = await lookUpAges(
            context.env,
            domainsToAge(probe.items, FREE_MAIL),
            rdapDeps(context.environment.rdap),
          )
          probe = probeMail(items, args.limit, knownAges(context.env))
        }
        const seconds = Math.round((Date.now() - started) / 100) / 10
        renderAnswer(
          this,
          outputFor(this),
          itemOf({
            address,
            folders,
            emails: probe.emails,
            bytes: probe.bytes,
            sent: probe.sent,
            without_headers: probe.withoutHeaders,
            groups: probe.groups,
            items: probe.items.map((group) => ({
              from: group.from,
              list_id: group.listId,
              emails: group.emails,
              bytes: group.bytes,
              unread: group.unread,
              bulk: group.bulk,
              first_year: group.firstYear,
              last_year: group.lastYear,
              replied: group.replied,
              suggest: group.suggest,
              score: group.score,
              signals: group.signals,
              untrusted: ["from", "list_id"],
            })),
            presets: probe.presets,
            ...(lookups === undefined ? {} : { domain_lookups: lookups }),
            seconds,
          }),
          () => probeText(probe, seconds),
        )
      } finally {
        await backend.close()
      }
    })

export const accountCommand = (): Command =>
  annotate(new Command("account"), { effects: LOCAL_READ })
    .description("the mailbox behind this profile")
    .addCommand(checkCommand())
    .addCommand(inspectCommand())
