import { createReadStream } from "node:fs"
import { open, stat } from "node:fs/promises"
import { CliError } from "@wirecat/cli-base"
import { headersOf, type Listed, type MailSource, systemLabel } from "@wirecat/cli-core/mail"

const unfold = (text: string): string => text.replace(/\r?\n[ \t]+/g, " ")

const field = (unfolded: string, name: string): string | undefined =>
  new RegExp(`^${name}:[ \\t]*(.*?)\\r?$`, "im").exec(unfolded)?.[1]

interface Entry {
  item: Listed
  start: number
  /** Where the email itself starts, after its "From " line. */
  body: number
  end: number
}

const NEWLINE = 10
const CR = 13
const SEPARATOR = Buffer.from("\nFrom ")
const MAX_HEADER = 256 * 1024
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
/** Takeout's own marks, not labels the owner gave: read state and "not in Inbox". */
const PSEUDO_LABELS = new Set(["Opened", "Unread", "Archived"])

/**
 * `Mon Jul 24 10:00:00 +0000 2023`: asctime, with the zone Takeout writes. Without one it is UTC, as the mbox format
 * defines it: https://www.rfc-editor.org/rfc/rfc4155#appendix-A
 */
const separatorDate = (rest: string): number | undefined => {
  const match = /(\w{3}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2})(?: ([+-])(\d{2})(\d{2}))? (\d{4})/.exec(rest)
  if (match === null) return undefined
  const [, month = "", day, hour, minute, second, sign, offsetHours, offsetMinutes, year] = match
  if (!MONTHS.includes(month)) return undefined
  const local = Date.UTC(Number(year), MONTHS.indexOf(month), Number(day), Number(hour), Number(minute), Number(second))
  const offset = sign === undefined ? 0 : (Number(offsetHours) * 60 + Number(offsetMinutes)) * 60_000
  return local - (sign === "-" ? -offset : offset)
}

/** RFC 2047 encoded words, which Takeout uses for labels outside ASCII. */
const decodeWords = (text: string): string =>
  text
    .replace(/(\?=)\s+(=\?)/g, "$1$2")
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_, charset: string, encoding: string, data: string) => {
      const bytes =
        encoding.toUpperCase() === "B"
          ? Buffer.from(data, "base64")
          : Buffer.from(
              data
                .replace(/_/g, " ")
                .replace(/=([0-9A-Fa-f]{2})/g, (_hex, hex: string) => String.fromCharCode(parseInt(hex, 16))),
              "latin1",
            )
      try {
        return new TextDecoder(charset).decode(bytes)
      } catch {
        return bytes.toString("utf8")
      }
    })

const splitLabels = (value: string): string[] => {
  const labels: string[] = []
  let current = ""
  let quoted = false
  for (const c of value) {
    if (c === '"') quoted = !quoted
    else if (c === "," && !quoted) {
      labels.push(current)
      current = ""
    } else current += c
  }
  labels.push(current)
  return labels.map((label) => label.trim()).filter(Boolean)
}

/** RFC 5322 requires the zone; `Date.parse` would read a date without one in this computer's zone. */
const ZONED = /(?:[+-]\d{4}|\b(?:UT|GMT|[ECMP][SD]T|[A-IK-Z]))\s*(?:\([^)]*\))?\s*$/i
const headerDate = (value: string | undefined): number =>
  value !== undefined && ZONED.test(value.trim()) ? Date.parse(value) : Number.NaN

const entryOf = (separator: string, header: string, start: number, body: number): Entry => {
  const [, sender = "", rest = ""] = /^From (\S+) ?(.*)$/.exec(separator) ?? []
  const messageId = /^(\d+)@/.exec(sender)?.[1]
  // The id is what joins this archive to the IMAP account; never invented, so a wrong guess fails here.
  if (messageId === undefined)
    throw new CliError(
      "invalid_response",
      `the mbox email at byte ${start} has no Gmail message id: its "From " line should read "From <digits>@xxx <date>"`,
    )
  const unfolded = unfold(header)
  const date = separatorDate(rest) ?? headerDate(field(unfolded, "Date"))
  if (Number.isNaN(date))
    throw new CliError(
      "invalid_response",
      `the mbox email at byte ${start} has no readable date: neither its "From " line nor a Date header with a zone`,
    )
  const written = field(unfolded, "X-Gmail-Labels")
  const raw = written === undefined ? undefined : splitLabels(decodeWords(written))
  const labels =
    raw === undefined ? undefined : [...new Set(raw.filter((name) => !PSEUDO_LABELS.has(name)).map(systemLabel))].sort()
  const seen = raw?.includes("Unread") ? false : raw?.includes("Opened") ? true : undefined
  const threadId = field(unfolded, "X-GM-THRID")?.trim()
  return {
    item: {
      uid: messageId,
      messageId,
      threadId: threadId || messageId,
      receivedAt: new Date(date).toISOString(),
      ...(labels === undefined ? {} : { labels, flagged: labels.includes("Starred") }),
      ...(seen === undefined ? {} : { seen }),
      headers: headersOf(header),
    },
    start,
    body,
    end: -1,
  }
}

/**
 * One pass over the file: a "From " line after a blank line starts an email. Only headers are kept in memory;
 * bodies are skipped with a byte search, so a 20 GB archive costs one read and no more memory than its headers.
 */
const scan = async (path: string, chunkSize: number): Promise<Entry[]> => {
  const entries: Entry[] = []
  let base = 0
  let pos = 0
  let bodyFrom = 0
  let inHeaders = true
  let separator: string | undefined
  let start = 0
  let body = 0
  let lines: Buffer[] = []
  let headerBytes = 0

  const take = (buf: Buffer, eof: boolean): number => {
    for (;;) {
      if (inHeaders) {
        let nl = buf.indexOf(NEWLINE, pos)
        if (nl === -1) {
          if (!eof || pos >= buf.length) return Math.max(0, pos - 2)
          nl = buf.length
        }
        let line = buf.subarray(pos, nl)
        if (line.at(-1) === CR) line = line.subarray(0, -1)
        if (separator === undefined) {
          separator = line.toString("latin1")
          if (!separator.startsWith("From "))
            throw new CliError(
              "validation_error",
              `${path} is not an mbox file: byte ${base + pos} starts no "From " line`,
            )
          start = base + pos
          body = base + nl + 1
        } else if (line.length === 0) {
          entries.push(entryOf(separator, Buffer.concat(lines).toString("utf8"), start, body))
          lines = []
          headerBytes = 0
          inHeaders = false
          bodyFrom = nl
        } else if (headerBytes < MAX_HEADER) {
          lines.push(Buffer.from(line), Buffer.from("\n"))
          headerBytes += line.length + 1
        }
        pos = nl + 1
        continue
      }
      const at = buf.indexOf(SEPARATOR, bodyFrom)
      if (at === -1) {
        const next = Math.max(bodyFrom, buf.length - (SEPARATOR.length - 1))
        const keep = Math.max(0, next - 2)
        bodyFrom = next - keep
        return keep
      }
      const blank = buf[at - 1] === NEWLINE || (buf[at - 1] === CR && buf[at - 2] === NEWLINE)
      if (!blank) {
        bodyFrom = at + 1
        continue
      }
      const last = entries.at(-1)
      if (last) last.end = base + at + 1
      inHeaders = true
      separator = undefined
      pos = at + 1
    }
  }

  let carry: Buffer = Buffer.alloc(0)
  for await (const chunk of createReadStream(path, { highWaterMark: chunkSize })) {
    const buf = carry.length ? Buffer.concat([carry, chunk as Buffer]) : (chunk as Buffer)
    const keep = take(buf, false)
    base += keep
    pos -= keep
    carry = buf.subarray(keep)
  }
  take(carry, true)
  if (inHeaders && separator !== undefined)
    entries.push(entryOf(separator, Buffer.concat(lines).toString("utf8"), start, body))
  const last = entries.at(-1)
  if (last && last.end === -1) last.end = base + carry.length
  for (const entry of entries) entry.item.size = entry.end - entry.start
  return entries
}

/** The email as Gmail stored it: the blank line mbox adds after it removed, and mboxrd's `>From ` undone. */
const asStored = (bytes: Buffer): Uint8Array => {
  const text = bytes.toString("latin1")
  const trimmed = /\r?\n\r?\n$/.test(text) ? text.replace(/\r?\n$/, "") : text
  return Buffer.from(trimmed.replace(/^>(>*From )/gm, "$1"), "latin1")
}

/**
 * A Google Takeout mbox of Gmail: the same message and thread ids IMAP reports, so its emails and the
 * account's IMAP emails are one set. Spam and Trash are left out, as IMAP's All Mail leaves them out.
 */
export const mboxSource = (path: string, { chunkSize = 1024 * 1024 }: { chunkSize?: number } = {}): MailSource => {
  let index: Promise<Map<string, Entry>> | undefined
  const indexed = () => {
    index ??= scan(path, chunkSize).then((entries) => new Map(entries.map((entry) => [entry.item.messageId, entry])))
    return index
  }
  return {
    list: async (since, folder) =>
      [...(await indexed()).values()]
        .filter(
          ({ item }) =>
            Date.parse(item.receivedAt) >= since.getTime() &&
            !item.labels?.some((label) => label === "Spam" || label === "Trash"),
        )
        .map(({ item }) => ({ ...item, folder })),

    stamp: async () => {
      const { size, mtimeMs } = await stat(path)
      return { size, mtimeMs }
    },

    fetchRaw: async (quick) => {
      const items = quick as Listed[]
      const entries = await indexed()
      const handle = await open(path)
      try {
        const read: (Uint8Array | Error)[] = []
        for (const item of items) {
          const entry = entries.get(item.messageId)
          if (entry === undefined) {
            read.push(new CliError("not_found", `email ${item.messageId} is not in the mbox file`))
            continue
          }
          const bytes = Buffer.alloc(entry.end - entry.body)
          await handle.read(bytes, 0, bytes.length, entry.body)
          read.push(asStored(bytes))
        }
        return read
      } finally {
        await handle.close()
      }
    },
  }
}
