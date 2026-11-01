import type { MailServerAccess } from "@wirecat/cli-core/mail"
import type { Command } from "commander"
import { DEFAULT_SEARCH, providerFor } from "../providers.js"
import { contextOf, openMail } from "./context.js"
import { foldersFor } from "./sync.js"

/**
 * What `search messages --backend` may do with this profile's mailbox: the provider registry picks Gmail's X-GM-RAW
 * or plain UID SEARCH and the folders, unless the profile names its own.
 */
export const serverAccess = (command: Command): MailServerAccess => {
  const context = contextOf(command)
  const { settings } = context
  return {
    offline: context.flags.offline === true,
    permissions: settings.permissions,
    readOnly: settings.readOnlyLock !== undefined,
    open: async () => {
      const { backend } = await openMail(context)
      const { address, host, folders: configured } = settings.mailbox
      const search = providerFor(address ?? "", host)?.search ?? DEFAULT_SEARCH
      const serverQuery = backend.serverQuery
      try {
        const folders = await foldersFor(undefined, configured, search, () => backend.folderList())
        return {
          source: {
            ...backend,
            ...(serverQuery ? { query: (criteria, folder) => serverQuery(criteria, folder, search.syntax) } : {}),
          },
          folders,
          close: backend.close,
        }
      } catch (error) {
        await backend.close()
        throw error
      }
    },
  }
}
