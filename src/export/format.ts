import { hostname } from "node:os"

export type ExportFormat = "mbox" | "maildir"

const ASCTIME_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const ASCTIME_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

const asctime = (at: Date): string => {
  const two = (n: number) => String(n).padStart(2, "0")
  return (
    `${ASCTIME_DAYS[at.getUTCDay()]} ${ASCTIME_MONTHS[at.getUTCMonth()]} ${String(at.getUTCDate()).padStart(2, " ")} ` +
    `${two(at.getUTCHours())}:${two(at.getUTCMinutes())}:${two(at.getUTCSeconds())} ${at.getUTCFullYear()}`
  )
}

/**
 * One message as mboxrd writes it (https://www.rfc-editor.org/rfc/rfc4155#appendix-A): a `From ` line, the bytes with
 * every line that starts `From ` or `>…From ` pushed one `>` deeper so a reader can undo it, and a blank line after.
 * The message keeps its own line endings, so a signature over the bytes still holds.
 */
export const mboxEntry = (raw: Uint8Array, receivedAt: number | null): Buffer => {
  const body = Buffer.from(raw)
    .toString("latin1")
    .replace(/^(>*From )/gm, ">$1")
  const eol = body.includes("\r\n") ? "\r\n" : "\n"
  const closed = body.endsWith("\n") ? body : body + eol
  const date = receivedAt === null ? new Date(0) : new Date(receivedAt)
  return Buffer.from(`From MAILER-DAEMON ${asctime(date)}${eol}${closed}${eol}`, "latin1")
}

const unsafe = /[\0/\\:*?"<>|]/g

/** `Archive/2025` becomes `Archive.2025.mbox`; one file per folder, flat in the destination. */
export const mboxFile = (folder: string): string => `${folder.replace(unsafe, ".")}.mbox`

/**
 * Maildir++ (as Dovecot, mbsync, mu and notmuch read it): INBOX is the top directory and every other folder a
 * `.Name` directory beside it, with `.` between levels.
 */
export const maildirDir = (folder: string): string =>
  folder.toUpperCase() === "INBOX" ? "" : `.${folder.replace(unsafe, ".").replace(/^\.+/, "")}`

const flagsOf = (read: boolean | null, flagged: boolean | null): string => `${flagged ? "F" : ""}${read ? "S" : ""}`

/** Unique and the same on every run for one message, so a resumed export finds what it already wrote. */
export const maildirName = (
  receivedAt: number | null,
  validity: string,
  uid: number,
  read: boolean | null,
  flagged: boolean | null,
): string => {
  const host = hostname().replace(/[^A-Za-z0-9-]/g, "-") || "localhost"
  const seconds = Math.floor((receivedAt ?? 0) / 1000)
  return `${seconds}.V${validity}U${uid}.${host}:2,${flagsOf(read, flagged)}`
}
