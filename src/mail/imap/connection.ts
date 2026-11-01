import { backoffMs, CliError, realSleep } from "@wirecat/cli-base"
import { ImapFlow } from "imapflow"
import type { MailEndpoint, RunBounds } from "../backend.js"
import { mapImapError } from "./errors.js"

/**
 * How the source spends a connection. The defaults come from measuring Yandex 360 (cli-testing,
 * performance/mail/yandex-imap-sync): a header FETCH takes 0.1 to 0.7 s per message and the time per message grows with
 * the size of the command, four connections read 2 to 3 times faster than one, and the server sometimes answers one
 * message with `NO [UNAVAILABLE]` and then closes the connection. So a call reads 15 messages on each of 4 connections:
 * a request of the budget (listBatch, fetchBatch) is 60 messages and takes about 9 s.
 */
export interface ImapTuning extends RunBounds {
  /** Messages in one FETCH command. */
  listSize?: number
  /** UIDs in one FETCH that asks only for flags, date and size. */
  quickSize?: number
  fetchSize?: number
  /** Bytes of message bodies one FETCH asks for, by RFC822.SIZE; a single larger message still goes alone. */
  fetchBytes?: number
  /** Parallel connections one `list` or `fetchRaw` call spreads its commands over. */
  connections?: number
  /** One command's own limit; the socket limit only catches a dead line. */
  requestTimeoutMs?: number
  /** Full-jitter backoff before each retry of a command. */
  backoff?: { baseDelayMs: number; maxDelayMs: number }
  /** A hard ceiling per command; the budget and the deadline usually stop the retries first. */
  maxAttempts?: number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  random?: () => number
  /** Calls `fire` after `ms` unless the returned cancel runs first. */
  expireAfter?: (ms: number, fire: () => void) => () => void
}

export const IMAP_DEFAULTS = {
  listSize: 15,
  quickSize: 500,
  fetchSize: 15,
  fetchBytes: 20 * 1024 * 1024,
  connections: 4,
  requestTimeoutMs: 90_000,
  backoff: { baseDelayMs: 1_000, maxDelayMs: 10_000 },
  maxAttempts: 8,
} as const

const realTimer = (ms: number, fire: () => void) => {
  const timer = setTimeout(fire, ms)
  return () => clearTimeout(timer)
}

type Work<T> = (open: ImapFlow, validity: string) => Promise<T>

export interface Connections {
  connections: number
  /** Each folder's UIDVALIDITY as the run first saw it; a reconnect that finds another one stops the run. */
  validities: Map<string, string>
  /** `work` on a connection with no folder selected, retried like every read. */
  onServer<T>(work: (open: ImapFlow) => Promise<T>): Promise<T>
  inFolder<T>(folder: string, work: Work<T>, expected?: string, slot?: number): Promise<T>
  /** Runs `work` over the batches on up to `connections` connections; the first failure stops the others. */
  spread<I, O, E = never>(
    folder: string,
    batches: I[],
    work: (open: ImapFlow, batch: I) => Promise<O>,
    expected: string | undefined,
    onError?: (error: unknown, batch: I) => E,
  ): Promise<(O | E)[]>
  close(): Promise<void>
}

/** The connections of one source, opened on first use; the password never leaves this closure. */
export const imapConnections = (endpoint: MailEndpoint, password: string, tuning: ImapTuning = {}): Connections => {
  const { connections, requestTimeoutMs, backoff, maxAttempts } = { ...IMAP_DEFAULTS, ...tuning }
  const { canRetry, timeLeftMs, signal, sleep = realSleep, random = Math.random, expireAfter = realTimer } = tuning
  const clients: (ImapFlow | undefined)[] = []
  const validities = new Map<string, string>()
  let closed = false

  const connect = async (slot: number): Promise<ImapFlow> => {
    if (closed) throw new CliError("cancelled", "the mail connection is already closed")
    const existing = clients[slot]
    if (existing?.usable) return existing
    const next = new ImapFlow({
      host: endpoint.host,
      port: endpoint.port,
      secure: endpoint.security === "tls",
      doSTARTTLS: endpoint.security === "starttls",
      auth: { user: endpoint.login, pass: password },
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 120000,
    })
    // An 'error' event with no listener would end the process, and the failing call already rejects.
    next.on("error", () => {})
    await next.connect()
    // A close that ran while this one was logging in found nothing to close.
    if (closed) {
      next.close()
      throw new CliError("cancelled", "the mail connection is already closed")
    }
    clients[slot] = next
    return next
  }

  const drop = (slot: number) => {
    const open = clients[slot]
    clients[slot] = undefined
    try {
      open?.close()
    } catch {}
  }

  /** One command's own deadline, cut to the run's: a stuck command closes its connection and fails as a timeout. */
  const limited = async <T>(slot: number, work: Promise<T>): Promise<T> => {
    const left = timeLeftMs?.()
    const ms = left === undefined ? requestTimeoutMs : Math.max(1, Math.min(requestTimeoutMs, left))
    let cancel = () => {}
    const expired = new Promise<never>((_, reject) => {
      cancel = expireAfter(ms, () => {
        drop(slot)
        reject(Object.assign(new Error("request timed out"), { code: "RequestTimeout" }))
      })
    })
    work.catch(() => {})
    try {
      return await Promise.race([work, expired])
    } finally {
      cancel()
    }
  }

  const once = async <T>(
    slot: number,
    folder: string | undefined,
    expected: string | undefined,
    work: Work<T>,
  ): Promise<T> => {
    const open = await limited(slot, connect(slot))
    if (folder === undefined) return limited(slot, work(open, ""))
    const lock = await limited(slot, open.getMailboxLock(folder, { readOnly: true }))
    try {
      // imapflow clears the selection when a SELECT fails or the server closes the mailbox, and a connection
      // in that state still counts as usable: a command sent on it fails with NoMailboxSelected.
      if (!open.mailbox) throw Object.assign(new Error("no mailbox is selected"), { code: "NoMailboxSelected" })
      const validity = String(open.mailbox.uidValidity)
      const was = expected ?? validities.get(folder)
      if (was !== undefined && validity !== was)
        throw new CliError("invalid_response", "UIDVALIDITY changed during the run; run it again", {
          reason: "mail.uidvalidity-changed",
        })
      return await limited(slot, work(open, validity))
    } finally {
      try {
        lock.release()
      } catch {}
    }
  }

  /**
   * Every call here only reads, so a failed command is safe to send again. A dropped line or a command that timed
   * out closes its connection, waits and tries on a fresh one, for as long as the run's budget and deadline allow.
   */
  const retrying = async <T>(slot: number, command: () => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await command()
      } catch (raw) {
        const error = mapImapError(raw)
        const transient =
          error.code === "network_error" || error.code === "timeout" || error.code === "provider_unavailable"
        if (transient) drop(slot)
        if (!transient || closed || attempt >= maxAttempts || signal?.aborted) throw error
        const wait = backoffMs(attempt, { ...backoff, retries: maxAttempts, maxRetryAfterMs: 0 }, random)
        const left = timeLeftMs?.()
        if (left !== undefined && left <= wait) throw error
        if (canRetry && !canRetry()) throw error
        await sleep(wait, signal).catch(() => Promise.reject(signal?.reason ?? error))
      }
    }
  }

  const inFolder = <T>(folder: string, work: Work<T>, expected?: string, slot = 0): Promise<T> =>
    retrying(slot, () => once(slot, folder, expected, work))

  const spread = async <I, O, E = never>(
    folder: string,
    batches: I[],
    work: (open: ImapFlow, batch: I) => Promise<O>,
    expected: string | undefined,
    onError?: (error: unknown, batch: I) => E,
  ): Promise<(O | E)[]> => {
    const results: (O | E)[] = new Array(batches.length)
    let next = 0
    let failure: unknown
    const worker = async (slot: number) => {
      for (;;) {
        const index = next++
        if (index >= batches.length || failure !== undefined) return
        const batch = batches[index] as I
        try {
          results[index] = await inFolder(folder, (open) => work(open, batch), expected, slot)
        } catch (error) {
          if (onError === undefined) {
            failure ??= error
            return
          }
          try {
            results[index] = onError(error, batch)
          } catch (fatal) {
            failure ??= fatal
            return
          }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(connections, batches.length) }, (_, slot) => worker(slot)))
    if (failure !== undefined) throw failure
    return results
  }

  return {
    connections,
    validities,
    onServer: (work) => retrying(0, () => once(0, undefined, undefined, (open) => work(open))),
    inFolder,
    spread,
    close: async () => {
      closed = true
      const open = clients.splice(0)
      await Promise.all(
        open.map(async (one) => {
          if (!one) return
          try {
            await one.logout()
          } catch {
            one.close()
          }
        }),
      )
    },
  }
}
