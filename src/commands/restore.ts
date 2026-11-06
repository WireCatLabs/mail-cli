import { annotate } from "@wirecat/cli-base/commands"
import type { NextStep } from "@wirecat/cli-base/standards"
import { answerEntity, itemOf, REMOTE_WRITE } from "@wirecat/cli-core/cli"
import { Command } from "commander"
import * as v from "valibot"
import { IDENTITY } from "../identity.js"
import { readRun } from "../mail/changes.js"
import { Changer } from "../mail/organise.js"
import { restoreRun } from "../mail/restore.js"
import { organising, writeSchema, yesOf } from "./organising.js"
import { answerLocally } from "./times.js"

const mailRestore = v.looseObject({
  run_id: v.nullable(v.string()),
  restored_run_id: v.string(),
  applied: v.boolean(),
  command: v.string(),
  logged: v.number(),
  restorable: v.number(),
  missing: v.number(),
  restored: v.number(),
  expired: v.boolean(),
  restorable_until: v.nullable(v.string()),
  writes: v.optional(v.array(writeSchema)),
})

export const restoreCommand = (): Command =>
  answerEntity(
    annotate(new Command("restore"), {
      effects: REMOTE_WRITE,
      examples: [
        `${IDENTITY.command} personal messages restore --run 20261101T101500Z-messages-delete-1a2b3c`,
        `${IDENTITY.command} personal messages restore --run 20261101T101500Z-messages-delete-1a2b3c --yes`,
        `${IDENTITY.command} personal messages restore --run 20261101T101500Z-messages-delete-1a2b3c --write <id> --yes`,
      ],
    }),
    "mail_restore",
    mailRestore,
  )
    .summary("undo a run of messages delete, move, copy or a flag change")
    .description(
      "undo a change run, last step first, for the messages still where it left them: Trash back to where they were, " +
        "moves back, copies removed, flags as they were; --write undoes one write of it alone; a preview unless --yes",
    )
    .requiredOption("--run <id>", "the run id a change answered with (runs list shows recent runs)")
    .option("--write <id>", "undo only this write of the run: an operation_id its answer listed under writes")
    .option("--yes", "make the change; without it, only say what would come back")
    .option("--dry-run", "only preview, even with --yes")
    .addHelpText(
      "after",
      `
memo mail delete runs restore here too, by their id. Mail Gmail has emptied from Trash (30 days) cannot come back.
Envelopes come back to search at once; mail with text is saved again by the next sync.`,
    )
    .action(async function (this: Command, options: { run: string; write?: string; dryRun?: boolean }) {
      await organising(this, async (opened) => {
        const found = readRun(opened.env, opened.mailbox.key.account, options.run)
        const apply = options.dryRun !== true && yesOf(this)
        const log = apply ? opened.log("message-restore") : undefined
        const changer = new Changer(
          opened.mailbox,
          opened.guard,
          log ?? { begin: () => 0, done: () => {} },
          "messages.restore",
          "message-restore",
        )
        try {
          const plan = await restoreRun(changer, found.run, found.path, apply, options.write)
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
                    args: { run: options.run, ...(options.write ? { write: options.write } : {}), yes: true },
                    why: "this was a preview; --yes moves them back",
                    safe_to_auto_execute: false,
                  },
                ]
              : []
          opened.answer(() =>
            answerLocally(
              this,
              itemOf(
                {
                  run_id: log?.run.id ?? null,
                  restored_run_id: plan.run,
                  applied: apply,
                  command: plan.command,
                  logged: plan.logged,
                  restorable: plan.restorable,
                  missing: plan.missing,
                  restored: plan.restored,
                  expired: plan.expired,
                  restorable_until: plan.restorable_until,
                  ...(apply ? { writes: changer.writes } : {}),
                },
                { next },
              ),
            ),
          )
        } finally {
          log?.end(Date.now())
        }
      })
    })
