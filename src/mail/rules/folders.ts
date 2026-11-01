import { DEFAULT_SYNC, providerFor } from "../../providers.js"
import type { MailBackend } from "../backend.js"

/**
 * The folders `sync` reads: `--folder`, else the profile's, else the provider's by role (INBOX and Sent, All Mail on
 * Gmail). `rules apply` lists the same ones, so a rule judges the mail sync stored from them.
 */
export const syncFoldersOf = async (
  mailbox: { address?: string; host?: string; folders?: string[] },
  backend: Pick<MailBackend, "folderList">,
  explicit?: string[],
): Promise<string[]> => {
  if (explicit?.length) return explicit
  if (mailbox.folders?.length) return mailbox.folders
  const defaults = (mailbox.address ? providerFor(mailbox.address, mailbox.host)?.sync : undefined) ?? DEFAULT_SYNC
  const chosen = (await backend.folderList())
    .filter((folder) => folder.role && defaults.roles.includes(folder.role))
    .map(({ path }) => path)
  return chosen.length ? chosen : [defaults.otherwise]
}
