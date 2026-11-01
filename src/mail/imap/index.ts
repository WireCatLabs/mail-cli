import type { MailBackend, MailEndpoint } from "../backend.js"
import { smtpSubmit } from "../smtp.js"
import { imapAccount } from "./account.js"
import { type ImapTuning, imapConnections } from "./connection.js"
import { imapReads } from "./read.js"
import { imapWrites } from "./write.js"

export { IMAP_DEFAULTS, type ImapTuning } from "./connection.js"
export { mapImapError } from "./errors.js"

/** The IMAP adapter of the mail backend, its connections opened on first use and closed by `close`. */
export const imapBackend = (endpoint: MailEndpoint, password: string, tuning: ImapTuning = {}): MailBackend => {
  const pool = imapConnections(endpoint, password, tuning)
  return {
    ...imapReads(pool, tuning),
    ...imapAccount(pool, endpoint.login),
    writes: imapWrites(pool),
    ...(endpoint.smtp ? { submit: smtpSubmit({ ...endpoint.smtp, login: endpoint.login }, password, tuning) } : {}),
    close: pool.close,
  }
}
