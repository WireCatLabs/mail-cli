import type { MessageStore } from "@wirecat/cli-core/store"
import { parseMail } from "./mail/parse.js"
import type { Listed, MailSource } from "./mail/port.js"

// A stand-in for cli-core's `syncMail`, which is not released yet. It keeps the call shape `(source, store, options)`,
// so switching is one import. It has no resume points, deletion detection, rules or attachment text.

export interface SyncOptions {
  address: string
  folders: string[]
  since: Date
  limit?: number | undefined
  now?: () => number
  signal?: AbortSignal | undefined
}

export interface FolderReport {
  folder: string
  listed: number
  already_stored: number
  saved: number
  unreadable: number
}

export interface SyncReport {
  address: string
  since: string
  folders: FolderReport[]
  saved: number
  unreadable: number
}

const FETCH_CHUNK = 25

export const syncMail = async (source: MailSource, store: MessageStore, options: SyncOptions): Promise<SyncReport> => {
  const now = options.now ?? Date.now
  const startedAt = now()
  const address = options.address.toLowerCase()
  const accountId = await store.accounts.saveAccount({ provider: "email", account: address }, { name: address })
  const folders: FolderReport[] = []

  for (const folder of options.folders) {
    const report: FolderReport = { folder, listed: 0, already_stored: 0, saved: 0, unreadable: 0 }
    folders.push(report)
    const searched = source.search ? await source.search(options.since, folder) : undefined
    const all = await source.list(options.since, folder, searched ? { searched } : {})
    report.listed = all.length
    // Newest first, so a --limit keeps the mail the owner most likely wants.
    const newest = [...all].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
    const pending: Listed[] = []
    for (const item of newest) {
      if (options.limit !== undefined && pending.length >= options.limit) break
      if (await store.mail.email(accountId, item.messageId)) report.already_stored++
      else pending.push(item)
    }

    for (let start = 0; start < pending.length; start += FETCH_CHUNK) {
      options.signal?.throwIfAborted()
      const chunk = pending.slice(start, start + FETCH_CHUNK)
      const raws = await source.fetchRaw(chunk)
      for (const [index, item] of chunk.entries()) {
        const raw = raws[index]
        try {
          if (raw === undefined || raw instanceof Error) throw raw ?? new Error("not read")
          const mail = await parseMail(raw)
          await store.mail.saveThread({
            accountId,
            externalId: item.threadId,
            now: startedAt,
            emails: [
              {
                externalId: item.messageId,
                subject: mail.subject,
                from: mail.from,
                to: mail.to,
                cc: mail.cc,
                sentAt: mail.sentAt,
                receivedAt: Date.parse(item.receivedAt),
                inReplyTo: mail.inReplyTo,
                references: mail.references,
                bodyText: mail.text,
                read: item.seen ?? null,
                flagged: item.flagged ?? null,
                size: item.size ?? null,
                mailboxes: [{ externalId: folder, name: folder, kind: null }],
              },
            ],
          })
          report.saved++
        } catch {
          report.unreadable++
        }
      }
    }
  }

  return {
    address,
    since: options.since.toISOString(),
    folders,
    saved: folders.reduce((sum, one) => sum + one.saved, 0),
    unreadable: folders.reduce((sum, one) => sum + one.unreadable, 0),
  }
}
