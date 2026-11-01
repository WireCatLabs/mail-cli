import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import {
  answerEntity,
  baseContext,
  LOCAL_READ,
  listOf,
  outputFor,
  positiveCount,
  renderAnswer,
} from "@wirecat/cli-core/cli"
import { Command, Option } from "commander"
import * as v from "valibot"
import { configuration } from "../config.js"
import { IDENTITY } from "../identity.js"
import { openMailStore } from "../store.js"
import { contextOf } from "./context.js"

const GROUPS = ["sender", "list", "domain"] as const
type Group = (typeof GROUPS)[number]

const mailGroup = v.strictObject({
  group: v.string(),
  emails: v.number(),
  unread: v.number(),
  bytes: v.number(),
  last_email_at: v.nullable(v.string()),
  untrusted: v.array(v.string()),
})

const keyOf = (by: Group, fact: { fromAddress: string | null; listId: string | null }): string | null => {
  if (by === "list") return fact.listId
  if (by === "sender") return fact.fromAddress?.toLowerCase() ?? null
  return fact.fromAddress?.split("@").at(-1)?.toLowerCase() ?? null
}

const topLeaf = (): Command =>
  answerEntity(
    annotate(new Command("top"), {
      effects: LOCAL_READ,
      partial: true,
      examples: [
        `${IDENTITY.command} ya stats messages top`,
        `${IDENTITY.command} ya stats messages top --by list --limit 10`,
      ],
    }),
    "mail_group",
    mailGroup,
  )
    .summary("senders, lists or domains with the most stored mail")
    .description(
      "group this profile's stored mail by sender, mailing list (List-Id) or sender domain, the biggest group first; " +
        "unread and size help decide what to unsubscribe from or clean up",
    )
    .addOption(new Option("--by <group>", "what to group by").choices([...GROUPS]).default("sender"))
    .option("--limit <n>", "how many groups, at most 200", positiveCount("--limit"), 20)
    .action(async function (this: Command, args: { by: Group; limit: number }) {
      const context = contextOf(this)
      const address = context.settings.mailbox.address
      if (!address) throw new CliError("configuration_error", `profile ${context.profile} has no address`)
      const limit = Math.min(args.limit, 200)
      const groups = await baseContext(this, configuration.resolveSettings).run(async () => {
        const store = await openMailStore(context.env)
        context.environment.trackCloseable?.(store)
        try {
          const stored = await store.accounts
            .storedAccount({ provider: "email", account: address.toLowerCase() })
            .catch(() => null)
          if (stored === null)
            throw new CliError(
              "not_found",
              `no mail is stored yet; run \`${IDENTITY.command} ${context.profile} sync\` first`,
            )
          const totals = new Map<string, { emails: number; unread: number; bytes: number; last: number }>()
          for (const fact of await store.mail.emailFacts({ accountId: stored.id })) {
            const key = keyOf(args.by, fact)
            if (!key) continue
            const total = totals.get(key) ?? { emails: 0, unread: 0, bytes: 0, last: 0 }
            total.emails++
            if (!fact.read) total.unread++
            total.bytes += fact.size ?? 0
            total.last = Math.max(total.last, fact.receivedAt ?? 0)
            totals.set(key, total)
          }
          return [...totals.entries()].sort(([, a], [, b]) => b.emails - a.emails || b.bytes - a.bytes)
        } finally {
          await store.close()
        }
      })
      const items = groups.slice(0, limit).map(([group, total]) => ({
        group,
        emails: total.emails,
        unread: total.unread,
        bytes: total.bytes,
        last_email_at: total.last ? new Date(total.last).toISOString() : null,
        untrusted: ["group"],
      }))
      renderAnswer(
        this,
        outputFor(this),
        listOf("stats messages top", { items, limit, has_more: groups.length > limit }),
        () =>
          items
            .map((one) => `${String(one.emails).padStart(6)}  ${String(one.unread).padStart(6)} unread  ${one.group}\n`)
            .join(""),
      )
    })

export const statsCommand = (): Command =>
  new Command("stats")
    .summary("statistics about stored mail")
    .description("counts over the mail sync stored")
    .addCommand(
      new Command("messages").summary("stored emails").description("counts of stored emails").addCommand(topLeaf()),
    )
