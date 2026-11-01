import { CliError } from "@wirecat/cli-base"
import type { AccountKey, MessageStore } from "@wirecat/cli-core/store"
import type { MailBackend } from "./backend.js"

export interface Rethreaded {
  /** Stored emails moved to the thread their References name. */
  moved: number
  /** False when the budget or the deadline stopped it; a later `--rescan` goes on. */
  complete: boolean
}

/**
 * Mail stored before thread ids came from References kept a thread of its own, and the sync skips stored mail, so
 * only a listing of its headers can move it. Gmail is not read: its thread ids are already the server's.
 */
export const rethreadStored = async (
  backend: MailBackend,
  store: MessageStore,
  key: AccountKey,
  folders: string[],
  since: Date,
  mayGoOn: () => boolean,
): Promise<Rethreaded> => {
  // A locked or broken store must fail the rescan, not report it done.
  const account = await store.accounts.storedAccount(key).catch((error: unknown) => {
    if (error instanceof CliError && error.code === "not_found") return null
    throw error
  })
  if (account === null || backend.search === undefined) return { moved: 0, complete: true }
  let moved = 0
  for (const folder of folders) {
    const searched = await backend.search(since, folder)
    if (!searched.quick) continue
    const slice = backend.listBatch ?? 200
    for (let start = 0; start < searched.uids.length; start += slice) {
      if (!mayGoOn()) return { moved, complete: false }
      const listed = await backend.list(since, folder, {
        searched: { ...searched, uids: searched.uids.slice(start, start + slice) },
      })
      const wanted = new Map(listed.map(({ messageId, threadId }) => [messageId, threadId]))
      const placed = await store.mail.inThreads(account.id, [...wanted.keys()])
      const astray = placed.filter(({ externalId, threadExternalId }) => wanted.get(externalId) !== threadExternalId)
      const now = Date.now()
      for (const { externalId } of astray) {
        const email = await store.mail.email(account.id, externalId)
        const threadId = wanted.get(externalId)
        if (email === null || threadId === undefined) continue
        // The required fields are written back as stored; the rest is left out, so it is kept.
        await store.mail.saveThread({
          accountId: account.id,
          externalId: threadId,
          now,
          emails: [
            {
              externalId,
              subject: email.subject,
              from: email.fromAddress === null ? null : { address: email.fromAddress, name: email.fromName },
              sentAt: email.sentAt,
              bodyText: email.bodyText,
            },
          ],
        })
        moved++
      }
    }
  }
  return { moved, complete: true }
}
