import { existsSync } from "node:fs"
import { CliError } from "@wirecat/cli-base"
import { baseContext } from "@wirecat/cli-core/cli"
import { mailAccountKey, readEmailWhole } from "@wirecat/cli-core/mail"
import { type MailReads, mailReadCommands } from "@wirecat/cli-core/mail/cli"
import { storePath } from "@wirecat/cli-core/store"
import { configuration } from "../config.js"
import { IDENTITY } from "../identity.js"
import { DEFAULT_SYNC, providerFor } from "../providers.js"
import { openMailStore } from "../store.js"
import { contextOf, openMail, refuseOffline } from "./context.js"
import { exportLeaf } from "./export.js"
import { importLeaf } from "./import.js"
import { serverAccess } from "./server-search.js"
import { foldersFor } from "./sync.js"

const reads: MailReads = {
  app: IDENTITY,
  server: serverAccess,
  serverTimeDefault: "5s, 20s on Yandex",
  // One email asked for by name is read whole, whatever the profile's attachment limit (NEED-223).
  whole: async (command, store, mailbox, emailId) => {
    const context = contextOf(command)
    refuseOffline(context.flags)
    const { backend } = await openMail(context)
    try {
      const { folders, host } = context.settings.mailbox
      const defaults = providerFor(mailbox.account, host)?.sync ?? DEFAULT_SYNC
      await readEmailWhole({
        store,
        source: backend,
        address: mailbox.account,
        externalId: emailId,
        folders: () => foldersFor(undefined, folders, defaults, () => backend.folderList()),
      })
    } finally {
      await backend.close()
    }
  },
  read: async (command, work) => {
    const context = contextOf(command)
    const address = context.settings.mailbox.address
    if (!address)
      throw new CliError(
        "configuration_error",
        `profile ${context.profile} has no address; run \`${IDENTITY.command} ${context.profile} session start --address <email>\``,
      )
    if (!existsSync(storePath(context.env)))
      throw new CliError(
        "not_found",
        `no mail is stored yet; run \`${IDENTITY.command} ${context.profile} sync\` first`,
      )
    return baseContext(command, configuration.resolveSettings).run(async () => {
      const store = await openMailStore(context.env)
      context.environment.trackCloseable?.(store)
      try {
        return await work(store, mailAccountKey(address))
      } finally {
        await store.close()
      }
    })
  },
}

/**
 * `search messages`, `messages show`, `conversations list|show`: cli-core's, over this profile's mailbox; the search
 * also asks the mail server (`--backend`).
 */
export const readCommands = () => {
  const commands = mailReadCommands(reads)
  commands
    .find((command) => command.name() === "messages")
    ?.addCommand(exportLeaf())
    .addCommand(importLeaf())
  return commands
}
