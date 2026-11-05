import { CliError } from "@wirecat/cli-base"
import type { Listed, MailSource, Quick, Searched } from "@wirecat/cli-core/mail"
import type { ImapFlow } from "imapflow"
import { type Connections, IMAP_DEFAULTS, type ImapTuning } from "./connection.js"
import { mapImapError } from "./errors.js"
import { HEADER_FIELDS, listedOf, quickOf, rawIdsOf } from "./messages.js"
import { searchUids } from "./search.js"

const chunks = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = []
  for (let start = 0; start < items.length; start += size) out.push(items.slice(start, start + size))
  return out
}

/** At most `count` messages and `bytes` of RFC822.SIZE per batch; a message larger than `bytes` goes alone. */
const bodyBatches = (items: Quick[], count: number, bytes: number): Quick[][] => {
  const out: Quick[][] = []
  let current: Quick[] = []
  let size = 0
  for (const item of items) {
    const next = item.size ?? 0
    if (current.length > 0 && (current.length >= count || size + next > bytes)) {
      out.push(current)
      current = []
      size = 0
    }
    current.push(item)
    size += next
  }
  if (current.length > 0) out.push(current)
  return out
}

/** Items of one folder read under one UIDVALIDITY go together: a folder is opened once per expected validity. */
const groupByFolder = (items: Quick[]): { folder: string; validity: string | undefined; items: Quick[] }[] => {
  const groups = new Map<string, { folder: string; validity: string | undefined; items: Quick[] }>()
  for (const item of items) {
    const folder = item.folder ?? "INBOX"
    const key = `${folder}\n${item.validity ?? ""}`
    const group = groups.get(key)
    if (group) group.items.push(item)
    else groups.set(key, { folder, validity: item.validity, items: [item] })
  }
  return [...groups.values()]
}

/** imapflow asks a server with OBJECTID for EMAILID, not X-GM-MSGID: Gmail's stored mail would get new ids. */
const gmailOf = (open: ImapFlow): boolean => {
  if (!open.capabilities.has("X-GM-EXT-1")) return false
  if (open.capabilities.has("OBJECTID"))
    throw new CliError(
      "provider_error",
      "Gmail now announces OBJECTID; this mail build cannot read its X-GM-MSGID ids",
      {
        reason: "mail.gmail-objectid",
      },
    )
  return true
}

type Reads = Required<Pick<MailSource, "listBatch" | "fetchBatch" | "search" | "present" | "quick" | "identify">> &
  Pick<MailSource, "list" | "fetchRaw">

/** The calls cli-core's sync makes to read a folder; none of them changes the mailbox. */
export const imapReads = (pool: Connections, tuning: ImapTuning = {}): Reads => {
  const { listSize, quickSize, fetchSize, fetchBytes } = { ...IMAP_DEFAULTS, ...tuning }
  const { validities, inFolder, spread, connections } = pool
  // Gmail keys its stored mail on X-GM-MSGID, which the bytes do not carry; fetchRaw reads it beside them.
  const gmailIds = new WeakMap<Quick, { messageId: string; threadId: string }>()

  const search = async (since: Date, folder: string): Promise<Searched> => {
    const found = await inFolder(folder, async (open, validity) => {
      const uids = await searchUids(open, { since }, folder)
      // Only Gmail's ids come free; elsewhere the id is the Message-ID, and the envelope costs a read per message.
      const quick = !open.capabilities.has("X-GM-EXT-1")
      return { ...(validity ? { validity } : {}), uids: uids.map(String), ...(quick ? { quick } : {}) }
    })
    if (found.validity) validities.set(folder, found.validity)
    return found
  }

  const validityOf = (searched: Searched, folder: string): string => {
    if (!searched.validity) throw new CliError("invalid_response", "IMAP did not report UIDVALIDITY")
    validities.set(folder, searched.validity)
    return searched.validity
  }

  return {
    listBatch: listSize * connections,
    fetchBatch: fetchSize * connections,
    search,

    present: (uids, folder) =>
      inFolder(folder, async (open) => {
        if (uids.length === 0) return []
        const held = new Set(await searchUids(open, { uid: uids.join(",") }, folder))
        return uids.filter((uid) => held.has(Number(uid)))
      }),

    list: async (since, folder, options) => {
      const searched = options?.searched ?? (await search(since, folder))
      const validity = validityOf(searched, folder)
      // A message the server answers with `NO [UNAVAILABLE]` is simply absent here; the sync asks for it again later.
      const listing = (batches: string[][]) =>
        spread(
          folder,
          batches,
          async (open, batch) => {
            const gmail = gmailOf(open)
            const fetched = await open.fetchAll(
              batch.join(","),
              {
                uid: true,
                flags: true,
                internalDate: true,
                size: true,
                envelope: true,
                threadId: true,
                labels: true,
                headers: HEADER_FIELDS,
              },
              { uid: true },
            )
            return fetched.map((message) => listedOf(message, folder, validity, gmail))
          },
          validity,
          (error) => {
            const mapped = mapImapError(error)
            if (mapped.code !== "provider_unavailable") throw mapped
            return mapped
          },
        )
      const batches = chunks(searched.uids, listSize)
      const parts = await listing(batches)
      const messages: Listed[] = []
      for (const [index, part] of parts.entries()) {
        const batch = batches[index] ?? []
        if (!(part instanceof Error)) for (const message of part) messages.push(message)
        // Yandex refuses even the headers of a message it can never read, and with it the whole FETCH.
        else if (batch.length > 1)
          for (const single of await listing(batch.map((uid) => [uid])))
            if (!(single instanceof Error)) for (const message of single) messages.push(message)
      }
      return messages
    },

    quick: async (_since, folder, { searched }) => {
      const validity = validityOf(searched, folder)
      const parts = await spread(
        folder,
        chunks(searched.uids, quickSize),
        (open, batch) =>
          open.fetchAll(batch.join(","), { uid: true, flags: true, internalDate: true, size: true }, { uid: true }),
        validity,
      )
      return parts.flat().map((message) => quickOf(message, folder))
    },

    identify: (raw, item) => {
      const folder = item.folder ?? "INBOX"
      return gmailIds.get(item) ?? rawIdsOf(raw, folder, item.validity ?? validities.get(folder) ?? "", item.uid)
    },

    fetchRaw: async (items, options) => {
      const read = new Map<Quick, Uint8Array | Error>()
      const bodies = (folder: string, batches: Quick[][], validity: string | undefined) =>
        spread(
          folder,
          batches,
          async (open, batch) => {
            const found = new Map<string, Uint8Array>()
            const gmail = gmailOf(open)
            const messages = await open.fetchAll(
              batch.map(({ uid }) => uid).join(","),
              {
                uid: true,
                source: options?.bytes ? { maxLength: options.bytes } : true,
                ...(gmail ? { threadId: true } : {}),
              },
              { uid: true },
            )
            const byUid = new Map(batch.map((item) => [item.uid, item]))
            for (const message of messages) {
              if (!message.source) continue
              found.set(String(message.uid), message.source)
              const item = byUid.get(String(message.uid))
              if (gmail && item && message.emailId && message.threadId)
                gmailIds.set(item, { messageId: String(message.emailId), threadId: String(message.threadId) })
            }
            return found
          },
          validity,
          (error) => {
            // A throttled or dropped connection fails the whole run; one unreadable batch costs only itself.
            const mapped = mapImapError(error)
            if (["rate_limited", "authentication_error", "network_error", "timeout"].includes(mapped.code)) throw mapped
            return mapped
          },
        )
      for (const { folder, validity, items: group } of groupByFolder(items)) {
        const batches = bodyBatches(group, fetchSize, fetchBytes)
        const answers = await bodies(folder, batches, validity)
        for (const [index, batch] of batches.entries()) {
          let answer = answers[index]
          // Yandex refuses a whole FETCH when one of its messages cannot be read; one by one, only that one is lost.
          if (answer instanceof CliError && answer.code === "provider_unavailable" && batch.length > 1) {
            const singles = await bodies(
              folder,
              batch.map((item) => [item]),
              validity,
            )
            answer = new Map()
            for (const [at, item] of batch.entries()) {
              const single = singles[at]
              const raw = single instanceof Map ? single.get(item.uid) : undefined
              if (raw !== undefined) answer.set(item.uid, raw)
              else if (single instanceof Error) read.set(item, single)
            }
          }
          for (const item of batch) {
            if (read.has(item)) continue
            const found = answer instanceof Map ? answer.get(item.uid) : undefined
            read.set(
              item,
              found ??
                (answer instanceof Error ? answer : undefined) ??
                new CliError("not_found", `email ${item.uid} was not returned`, { reason: "mail.not-returned" }),
            )
          }
        }
      }
      return items.map(
        (item) =>
          read.get(item) ??
          new CliError("not_found", `email ${item.uid} was not returned`, { reason: "mail.not-returned" }),
      )
    },
  }
}
