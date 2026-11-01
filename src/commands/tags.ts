import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import type { QueryRegistry } from "@wirecat/cli-base/query"
import { formatReference, normalizeTag, parseReference } from "@wirecat/cli-core"
import {
  answerEntity,
  itemOf,
  LOCAL_READ,
  LOCAL_WRITE,
  listOf,
  outputFor,
  queryTerms,
  renderAnswer,
  termField,
  withQuery,
} from "@wirecat/cli-core/cli"
import type { AccountKey, MessageStore, TagTarget } from "@wirecat/cli-core/store"
import { Command } from "commander"
import * as v from "valibot"
import { IDENTITY } from "../identity.js"
import { openMailStore } from "../store.js"
import { contextOf } from "./context.js"

const TYPES = ["message", "chat"] as const

const TAG_QUERY = {
  entity: "mail_tag",
  backend: "native",
  fields: [termField("tag", "kw", "tag:work"), termField("type", "enum", "type:message", { values: TYPES })],
} as const satisfies QueryRegistry

const mailTag = v.strictObject({
  tag: v.string(),
  type: v.picklist(TYPES),
  target: v.string(),
  name: v.nullable(v.string()),
  created_at: v.string(),
})

const tagChange = v.strictObject({
  target: v.string(),
  added: v.optional(v.array(v.string())),
  removed: v.optional(v.array(v.string())),
  unchanged: v.array(v.string()),
})

const REF = "msg:email/me%40example.com/t1/m1"
const LIST_LIMIT = 100
const MAX_LIST = 1_000

const limitOf = (value: string) => {
  if (!/^\d+$/.test(value.trim()) || Number(value) < 1 || Number(value) > MAX_LIST)
    throw new CliError("validation_error", `--limit takes a whole number from 1 to ${MAX_LIST}`, { param: "limit" })
  return Number(value)
}

/** The profile's own mailbox in the shared store; the tags of mail go on its rows, as memo's do. */
const withMailbox = async <T>(command: Command, work: (store: MessageStore, key: AccountKey) => Promise<T>) => {
  const context = contextOf(command)
  const address = context.settings.mailbox.address
  if (!address) throw new CliError("configuration_error", `profile ${context.profile} has no address`)
  const store = await openMailStore(context.env)
  try {
    return await work(store, { provider: "email", account: address.toLowerCase() })
  } finally {
    await store.close()
  }
}

const targetOf = (key: AccountKey, { message, chat }: { message?: string; chat?: string }): MailTarget => {
  if ((message === undefined) === (chat === undefined))
    throw new CliError("validation_error", "name one email with --message, or one conversation with --chat")
  const place = parseReference((message ?? chat) as string)
  if (message !== undefined && place.type !== "message")
    throw new CliError("validation_error", `${message} names no email — give the msg:email/… reference`, {
      param: "message",
    })
  if (chat !== undefined && place.type !== "chat")
    throw new CliError("validation_error", `${chat} names no conversation — give the chat:email/… reference`, {
      param: "chat",
    })
  if (place.type !== "message" && place.type !== "chat") throw new CliError("validation_error", "no mail reference")
  if (place.provider !== key.provider || place.account !== key.account)
    throw new CliError("not_found", `${message ?? chat} is not mail of this profile's mailbox ${key.account}`)
  return place.type === "message"
    ? { type: "message", chatId: place.chat, messageId: place.message }
    : { type: "chat", chatId: place.chat }
}

type MailTarget = Extract<TagTarget, { type: "message" | "chat" }>

const shown = (key: AccountKey, target: MailTarget) =>
  target.type === "message"
    ? formatReference({ type: "message", ...key, chat: target.chatId, message: target.messageId })
    : formatReference({ type: "chat", ...key, chat: target.chatId })

const change = (operation: "add" | "remove") =>
  answerEntity(
    annotate(new Command(operation), {
      effects: LOCAL_WRITE,
      examples: [`${IDENTITY.command} ya tags ${operation} invoices --message ${REF}`],
    }),
    "mail_tag_change",
    tagChange,
  )
    .summary(operation === "add" ? "tag one stored email or conversation" : "untag one stored email or conversation")
    .description(
      operation === "add"
        ? "put your own tags on one stored email or conversation; they stay in the local store, never on the server"
        : "take your own tags off one stored email or conversation",
    )
    .argument("<tag...>", "one or more tags: 1–32 letters a–z, digits and hyphens; upper case is lowered")
    .option("--message <message>", "the email: its msg:email/… reference, as search messages shows it")
    .option("--chat <chat>", "the conversation: its chat:email/… reference, as conversations list shows it")
    .action(async function (this: Command, given: string[], options: { message?: string; chat?: string }) {
      const tags = [...new Set(given.map(normalizeTag))]
      const done = await withMailbox(this, async (store, key) => {
        const target = targetOf(key, options)
        const changed =
          operation === "add"
            ? await store.tags.addTags(key, target, tags)
            : await store.tags.removeTags(key, target, tags)
        return { target: shown(key, target), changed }
      })
      const unchanged = tags.filter((tag) => !done.changed.includes(tag))
      renderAnswer(
        this,
        outputFor(this),
        itemOf({
          target: done.target,
          ...(operation === "add" ? { added: done.changed } : { removed: done.changed }),
          unchanged,
        }),
        () => `${done.target}: ${done.changed.length ? done.changed.join(", ") : "no tags changed"}\n`,
      )
    })

const listCommand = () =>
  withQuery(
    answerEntity(
      annotate(new Command("list"), {
        effects: LOCAL_READ,
        examples: [`${IDENTITY.command} ya tags list`, `${IDENTITY.command} ya tags list tag:invoices`],
      }),
      "mail_tag",
      mailTag,
    )
      .summary("your tagged emails and conversations")
      .description("the emails and conversations of this mailbox you tagged; search messages tag:<tag> finds them too")
      .option("--limit <n>", `at most this many (default ${LIST_LIMIT}, at most ${MAX_LIST})`, limitOf),
    TAG_QUERY,
  ).action(async function (this: Command, words: string[], options: { limit?: number }) {
    const terms = queryTerms(words, TAG_QUERY, "tags list")
    const tag = terms.get("tag")
    const type = terms.get("type") as (typeof TYPES)[number] | undefined
    const limit = options.limit ?? LIST_LIMIT
    const items = await withMailbox(this, async (store, key) => {
      const rows = (
        await Promise.all(
          (type === undefined ? TYPES : [type]).map((one) =>
            store.tags.tags(key, {
              ...(tag === undefined ? {} : { tag: normalizeTag(tag) }),
              type: one,
              window: { limit: limit + 1, offset: 0 },
            }),
          ),
        )
      ).flat()
      return rows.map((row) => {
        const target: MailTarget =
          row.type === "message"
            ? { type: "message", chatId: row.chatId as string, messageId: row.messageId as string }
            : { type: "chat", chatId: row.chatId as string }
        return {
          tag: row.tag,
          type: target.type,
          target: shown(key, target),
          name: row.chatTitle ?? null,
          created_at: row.createdAt,
        }
      })
    })
    renderAnswer(
      this,
      outputFor(this),
      listOf("tags list", { items: items.slice(0, limit), limit, has_more: items.length > limit }),
      () =>
        items.length === 0
          ? "nothing is tagged — tags add <tag> --message <ref> tags an email\n"
          : `${items
              .slice(0, limit)
              .map((one) => `${one.tag}  ${one.type}  ${one.target}`)
              .join("\n")}\n`,
    )
  })

export const tagsCommand = (): Command =>
  annotate(new Command("tags"), { effects: LOCAL_READ })
    .summary("your own tags on stored mail, local only, shared with memo")
    .description("your own tags on stored mail, kept in the local store and shared with memo; never sent to the server")
    .addCommand(change("add"))
    .addCommand(change("remove"))
    .addCommand(listCommand())
