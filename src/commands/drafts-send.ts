import { annotate } from "@wirecat/cli-base/commands"
import { answerEntity, outputFor, REMOTE_WRITE } from "@wirecat/cli-core/cli"
import { guardedWrite, newOperationId } from "@wirecat/cli-core/sends"
import { Command } from "commander"
import { IDENTITY } from "../identity.js"
import { type Draft, messageIdFor, peopleOf } from "../mail/compose.js"
import { draftIdOf, draftsFolderOf, findDraft } from "../mail/drafts.js"
import { organising } from "./messages.js"
import { go, mailSend, operationIdOf } from "./send.js"

interface Flags {
  operationId?: string
  dryRun?: boolean
}

/**
 * Sends a saved draft through the same path as `messages send` — its keys, question, limit, journal and Sent copy —
 * then takes it out of Drafts. A draft that cannot be removed stays and is said so: the mail has gone either way.
 */
export const draftSendCommand = (): Command =>
  answerEntity(
    annotate(new Command("send"), {
      effects: REMOTE_WRITE,
      examples: [`${IDENTITY.command} ya drafts send 5b0e1c2a@example.com`],
    }),
    "mail_send",
    mailSend,
  )
    .summary("send a saved draft, then remove it from Drafts")
    .description(
      "send a draft as it is saved, over SMTP, as messages send does: mail to anyone but you asks first " +
        "(permissions.messages.send.others); once it went, the draft leaves the Drafts folder",
    )
    .argument("<draft>", "the draft's id, as drafts list shows it")
    .option("--operation-id <id>", "repeat a send whose outcome was unknown; Sent is checked first, so it goes once")
    .option("--yes", "answer the question before sending to anyone but you")
    .option("--dry-run", "show what would go; send nothing")
    .action(async function (this: Command, given: string, flags: Flags) {
      const id = draftIdOf(given)
      const operationId = operationIdOf(flags.operationId)
      await organising(this, async (opened) => {
        const folder = draftsFolderOf(await opened.mailbox.folders(), opened.mailbox.organise)
        const found = await findDraft(opened.backend, folder, id)
        const { draft: saved, references, parts } = found.read
        const from = { address: opened.mailbox.key.account }
        const draft: Draft = {
          from,
          to: peopleOf(saved.to, "--to"),
          cc: peopleOf(saved.cc, "--cc"),
          bcc: peopleOf(saved.bcc, "--bcc"),
          subject: saved.subject,
          text: saved.text,
          messageId: messageIdFor(operationId, from.address),
          date: new Date(),
          ...(saved.in_reply_to ? { inReplyTo: saved.in_reply_to } : {}),
          ...(references.length ? { references } : {}),
          files: [],
          parts,
        }
        const sent = await go(
          this,
          opened,
          { draft, kind: "message", key: "messages.send", operationId, retry: flags.operationId !== undefined },
          flags.dryRun === true,
        )
        if (!sent) return
        try {
          await guardedWrite(
            opened.guard,
            { chatId: null, kind: "account", key: "drafts.send", operationId: newOperationId() },
            () => opened.mailbox.writes.expunge(folder, found.validity, [found.uid]),
          )
        } catch {
          outputFor(this).renderer.warn(`the draft was sent and is still in ${folder}; drafts delete removes it`)
        }
      })
    })
