import { randomUUID } from "node:crypto"
import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import {
  answerEntity,
  bufferedInput,
  environmentOf,
  itemOf,
  LOCAL_READ,
  listOf,
  outputFor,
  ownerOnlyOption,
  REMOTE_READ,
  REMOTE_WRITE,
  renderAnswer,
} from "@wirecat/cli-core/cli"
import { guardedWrite, newOperationId } from "@wirecat/cli-core/sends"
import { Command } from "commander"
import * as v from "valibot"
import { IDENTITY } from "../identity.js"
import {
  build,
  type Draft as Outgoing,
  originalOf,
  type Person,
  peopleOf,
  referencesOf,
  replyCopies,
  replyPeople,
  replySubject,
} from "../mail/compose.js"
import {
  type Changes,
  DRAFT_FLAGS,
  draftIdOf,
  draftsFolderOf,
  findDraft,
  listDrafts,
  nextVersion,
} from "../mail/drafts.js"
import { trashOf } from "../mail/organise.js"
import { fetchOriginal } from "../mail/send.js"
import { collect } from "./context.js"
import { draftSendCommand } from "./drafts-send.js"
import { type Opened, organising } from "./messages.js"
import { ownerOf } from "./send.js"

const LIST_LIMIT = 50
const MAX_LIST = 500

const mailDraft = v.strictObject({
  id: v.string(),
  uid: v.number(),
  subject: v.string(),
  from: v.nullable(v.string()),
  to: v.array(v.string()),
  cc: v.array(v.string()),
  bcc: v.array(v.string()),
  date: v.nullable(v.string()),
  in_reply_to: v.nullable(v.string()),
  attachments: v.array(v.strictObject({ name: v.string(), mime: v.nullable(v.string()) })),
  text: v.string(),
})

const draftChange = v.strictObject({
  action: v.picklist(["create", "update", "delete"]),
  applied: v.boolean(),
  id: v.string(),
  folder: v.string(),
  uid: v.nullable(v.number()),
  replaced_uid: v.optional(v.number()),
  old_version_in: v.optional(v.string()),
  subject: v.optional(v.string()),
  to: v.optional(v.array(v.string())),
  size: v.optional(v.number()),
  hint: v.optional(v.string()),
})

const REF = "msg:email/me%40example.com/t1/m1"
const ID = "5b0e1c2a@example.com"

const limitOf = (value: string) => {
  if (!/^\d+$/.test(value.trim()) || Number(value) < 1 || Number(value) > MAX_LIST)
    throw new CliError("validation_error", `--limit takes a whole number from 1 to ${MAX_LIST}`, { param: "limit" })
  return Number(value)
}

interface Fields {
  to?: string[]
  cc?: string[]
  bcc?: string[]
  subject?: string
  dryRun?: boolean
}

const addressing = (command: Command) =>
  command
    .option("--to <address>", "who it goes to; repeat it for more", collect)
    .option("--cc <address>", "a copy to; repeat it for more", collect)
    .option("--bcc <address>", "a blind copy to; repeat it for more", collect)
    .option("--subject <text>", "the subject line")
    .option("--dry-run", "build the draft and show it; store nothing")

const listed = (given: string[] | undefined, flag: string) => (given === undefined ? undefined : peopleOf(given, flag))
const addressesOf = (people: readonly Person[]) =>
  people.map(({ address, name }) => (name ? `${name} <${address}>` : address))

/** The text as given, `-` for stdin; stdin is read only when asked, as an MCP server's stdin is its own channel. */
const textOf = async (command: Command, text: string | undefined) => {
  if (text !== "-") return text
  const input = environmentOf(command).stdin ?? process.stdin
  if ((input as { isTTY?: boolean }).isTTY) throw new CliError("validation_error", "- reads the text from a pipe")
  return (await bufferedInput(input)).toString("utf8")
}

const ownAddress = (opened: Opened) => opened.mailbox.key.account

const draftsFolder = async (opened: Opened) => draftsFolderOf(await opened.mailbox.folders(), opened.mailbox.organise)

/** Every change to Drafts goes through the guard, with its own key; none counts toward the send limit. */
const guarded = <T>(opened: Opened, key: string, act: () => Promise<T>) =>
  guardedWrite(opened.guard, { chatId: null, kind: "account", key, operationId: newOperationId() }, act)

const answer = (command: Command, change: v.InferOutput<typeof draftChange>) =>
  renderAnswer(command, outputFor(command), itemOf(change), () =>
    change.applied
      ? `${change.action === "delete" ? "deleted" : "saved"} draft ${change.id} in ${change.folder}\n`
      : `${change.hint ?? "a preview: nothing changed"}\n`,
  )

/** The message `--reply-to` names, read from the server, so its ids and recipients are exactly what it holds. */
const replyTo = async (command: Command, opened: Opened, ref: string, all: boolean) => {
  const { raw } = await fetchOriginal(opened.mailbox, opened.backend, ref, opened.profile)
  const original = await originalOf(raw)
  if (!original.messageId)
    throw new CliError("invalid_response", `${ref} has no Message-ID, so a reply cannot name what it answers`)
  const owner = ownerOf(opened, command)
  const to = replyPeople(original, owner, false)
  return {
    to,
    cc: all ? replyCopies(original, owner, to) : [],
    subject: replySubject(original.subject),
    inReplyTo: original.messageId,
    references: referencesOf(original),
  }
}

const listCommand = () =>
  answerEntity(
    annotate(new Command("list"), {
      effects: REMOTE_READ,
      examples: [`${IDENTITY.command} ya drafts list`, `${IDENTITY.command} ya drafts list --limit 5 --json`],
    }),
    "mail_draft",
    mailDraft,
  )
    .summary("the drafts on the server, newest first")
    .description("the drafts in the mailbox's Drafts folder, newest first, read from the server")
    .option("--limit <n>", `at most this many (default ${LIST_LIMIT}, at most ${MAX_LIST})`, limitOf)
    .action(async function (this: Command, options: { limit?: number }) {
      await organising(this, async (opened) => {
        const limit = options.limit ?? LIST_LIMIT
        const found = await listDrafts(opened.backend, await draftsFolder(opened), limit)
        renderAnswer(
          this,
          outputFor(this),
          listOf("drafts list", { items: found.items, limit, has_more: found.more }),
          () =>
            found.items.length === 0
              ? "no drafts\n"
              : `${found.items.map((one) => `${one.id}  ${one.subject || "(no subject)"}  to ${one.to.join(", ") || "nobody yet"}`).join("\n")}\n`,
        )
      })
    })

const createCommand = () =>
  answerEntity(
    addressing(
      annotate(new Command("create"), {
        effects: REMOTE_WRITE,
        examples: [
          `${IDENTITY.command} ya drafts create --to anna@example.com --subject 'Monday' 'Shall we meet at ten?'`,
          `${IDENTITY.command} ya drafts create --reply-to ${REF} --reply-all 'Thanks, agreed.'`,
        ],
      }),
    ),
    "mail_draft_change",
    draftChange,
  )
    .summary("save a new draft for the owner to check and send")
    .description(
      "save a new message in the Drafts folder; nothing is sent, and the owner sends it from any mail app. " +
        "--reply-to answers a stored message in its thread",
    )
    .argument("[text]", "the text; - reads it from stdin")
    .option("--reply-to <message>", "answer this stored message: its sender, its subject with Re:, in its thread")
    .option("--reply-all", "with --reply-to, also everyone it went to, but you")
    .action(async function (
      this: Command,
      given: string | undefined,
      options: Fields & { replyTo?: string; replyAll?: boolean },
    ) {
      if (options.replyAll && !options.replyTo)
        throw new CliError("validation_error", "--reply-all goes with --reply-to", { param: "reply-all" })
      const body = (await textOf(this, given)) ?? ""
      await organising(this, async (opened) => {
        const reply = options.replyTo
          ? await replyTo(this, opened, options.replyTo, options.replyAll === true)
          : undefined
        const from = ownAddress(opened)
        const message: Outgoing = {
          from: { address: from },
          to: listed(options.to, "--to") ?? reply?.to ?? [],
          cc: [...(reply?.cc ?? []), ...(listed(options.cc, "--cc") ?? [])],
          bcc: listed(options.bcc, "--bcc") ?? [],
          subject: options.subject ?? reply?.subject ?? "",
          text: body,
          // A UUID, not an operation id: the owner types this id, and one starting with "-" reads as an option.
          messageId: `<${randomUUID()}@${from.split("@")[1] ?? "localhost"}>`,
          date: new Date(),
          ...(reply ? { inReplyTo: reply.inReplyTo, references: reply.references } : {}),
          files: [],
        }
        await saveDraft(this, opened, "create", message, options.dryRun === true)
      })
    })

const saveDraft = async (
  command: Command,
  opened: Opened,
  action: "create" | "update",
  message: Outgoing,
  dryRun: boolean,
  replacing?: { uid: number; validity: string },
) => {
  const folder = await draftsFolder(opened)
  // The copy keeps Bcc: a draft opened in another mail app must still show who gets a blind copy.
  const { copy: raw } = await build(message)
  const id = message.messageId.replace(/^<|>$/g, "")
  const shown = { id, folder, subject: message.subject, to: addressesOf(message.to), size: raw.length }
  if (dryRun)
    return answer(command, { action, applied: false, uid: null, ...shown, hint: "a preview: nothing was saved" })
  const writes = opened.mailbox.writes
  // The owner may have been writing the old version by hand, so it goes to Trash, where it can be got back.
  const trash = replacing ? await trashOf(opened.mailbox) : undefined
  const stored = await guarded(opened, `drafts.${action}`, async () => {
    const saved = await writes.append(folder, raw, DRAFT_FLAGS)
    // The new version is in place before the old one goes, so a failure in between leaves two drafts, never none.
    if (replacing && trash) await writes.move(folder, replacing.validity, [replacing.uid], trash)
    return saved
  })
  answer(command, {
    action,
    applied: true,
    uid: stored.uid ?? null,
    ...(replacing && trash ? { replaced_uid: replacing.uid, old_version_in: trash } : {}),
    ...shown,
  })
}

const updateCommand = () =>
  answerEntity(
    addressing(
      annotate(new Command("update"), {
        effects: REMOTE_WRITE,
        examples: [
          `${IDENTITY.command} ya drafts update ${ID} 'New text, the rest kept'`,
          `${IDENTITY.command} ya drafts update ${ID} --to anna@example.com --to boris@example.com`,
        ],
      }),
    ),
    "mail_draft_change",
    draftChange,
  )
    .summary("change a draft: what is given replaces it, the rest stays")
    .description(
      "replace a draft with a new version under the same id: each given field replaces the old one (a --to list " +
        "replaces the whole To), the rest, the thread and the attachments stay; the old version goes to Trash",
    )
    .argument("<draft>", "the draft's id, as drafts list shows it")
    .argument("[text]", "the new text; - reads it from stdin")
    .action(async function (this: Command, draft: string, given: string | undefined, options: Fields) {
      const id = draftIdOf(draft)
      const body = await textOf(this, given)
      await organising(this, async (opened) => {
        const folder = await draftsFolder(opened)
        const found = await findDraft(opened.backend, folder, id)
        const fields: Changes = {
          ...(options.to ? { to: peopleOf(options.to, "--to") } : {}),
          ...(options.cc ? { cc: peopleOf(options.cc, "--cc") } : {}),
          ...(options.bcc ? { bcc: peopleOf(options.bcc, "--bcc") } : {}),
          ...(options.subject === undefined ? {} : { subject: options.subject }),
          ...(body === undefined ? {} : { text: body }),
        }
        if (Object.keys(fields).length === 0)
          throw new CliError("validation_error", "give what changes: the text, --to, --cc, --bcc or --subject")
        await saveDraft(
          this,
          opened,
          "update",
          nextVersion(found.read, fields, ownAddress(opened)),
          options.dryRun === true,
          { uid: found.uid, validity: found.validity },
        )
      })
    })

const deleteCommand = () =>
  answerEntity(
    annotate(new Command("delete"), {
      effects: REMOTE_WRITE,
      examples: [`${IDENTITY.command} ya drafts delete ${ID} --allow-dangerous`],
    }),
    "mail_draft_change",
    draftChange,
  )
    .summary("delete a draft for good")
    .description(
      "delete a draft from the Drafts folder for good, with no restore; the owner adds --allow-dangerous to do it, without it a preview",
    )
    .argument("<draft>", "the draft's id, as drafts list shows it")
    .addOption(ownerOnlyOption("--allow-dangerous", "delete it for good, no restore; without it, only a preview"))
    .option("--dry-run", "only preview, even with --allow-dangerous")
    .action(async function (this: Command, draft: string, options: { dryRun?: boolean }) {
      const id = draftIdOf(draft)
      const dangerous = this.optsWithGlobals<{ allowDangerous?: boolean }>().allowDangerous === true
      await organising(this, async (opened) => {
        const folder = await draftsFolder(opened)
        const found = await findDraft(opened.backend, folder, id)
        const shown = {
          action: "delete" as const,
          id: found.read.draft.id,
          folder,
          uid: found.uid,
          subject: found.read.draft.subject,
          to: found.read.draft.to,
        }
        if (options.dryRun === true || !dangerous)
          return answer(this, {
            ...shown,
            applied: false,
            hint: "a preview: nothing changed; the owner adds --allow-dangerous to delete it for good",
          })
        await guarded(opened, "drafts.delete", () => opened.mailbox.writes.expunge(folder, found.validity, [found.uid]))
        answer(this, { ...shown, applied: true })
      })
    })

export const draftsCommand = (): Command =>
  annotate(new Command("drafts"), { effects: LOCAL_READ })
    .summary("drafts on the server: an agent writes them, the owner sends them")
    .description("drafts in the mailbox's Drafts folder: an agent writes them, the owner checks and sends them")
    .addCommand(listCommand())
    .addCommand(createCommand())
    .addCommand(updateCommand())
    .addCommand(deleteCommand())
    .addCommand(draftSendCommand())
