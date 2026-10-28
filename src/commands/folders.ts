import { annotate } from "@wirecat/cli-base/commands"
import { baseContext, LOCAL_READ, listOf, outputFor, REMOTE_READ, renderAnswer } from "@wirecat/cli-core/cli"
import { Command } from "commander"
import { configuration } from "../config.js"
import { IDENTITY } from "../identity.js"
import { contextOf, openSource, refuseOffline } from "./context.js"

const listCommand = () =>
  annotate(new Command("list"), {
    effects: REMOTE_READ,
    examples: [`${IDENTITY.command} ya folders list`, `${IDENTITY.command} ya folders list --json`],
  })
    .summary("the folders with their role and message counts")
    .description("the folders of the mailbox with their role (inbox, sent, trash, ...) and message counts")
    .action(async function (this: Command) {
      const context = contextOf(this)
      refuseOffline(context.flags)
      const { source } = await openSource(context)
      try {
        const folders = await baseContext(this, configuration.resolveSettings).run(() => source.folderList())
        renderAnswer(
          this,
          outputFor(this),
          listOf("folders list", { items: folders, limit: Math.max(1, folders.length), has_more: false }),
        )
      } finally {
        await source.close()
      }
    })

export const foldersCommand = (): Command =>
  annotate(new Command("folders"), { effects: LOCAL_READ })
    .description("the folders of this profile's mailbox")
    .addCommand(listCommand())
