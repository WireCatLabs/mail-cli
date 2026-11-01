import { existsSync } from "node:fs"
import { CliError } from "@wirecat/cli-base"
import { baseContext } from "@wirecat/cli-core/cli"
import { type MailReads, mailReadCommands } from "@wirecat/cli-core/mail/cli"
import { storePath } from "@wirecat/cli-core/store"
import { configuration } from "../config.js"
import { IDENTITY } from "../identity.js"
import { openMailStore } from "../store.js"
import { contextOf } from "./context.js"
import { serverAccess } from "./server-search.js"

const reads: MailReads = {
  app: IDENTITY,
  server: serverAccess,
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
        return await work(store, { provider: "email", account: address.toLowerCase() })
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
export const readCommands = () => mailReadCommands(reads)
