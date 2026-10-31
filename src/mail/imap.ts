import { createHash } from "node:crypto"
import { CliError } from "@wirecat/cli-base"
import type { Listed, MailHeaders, MailSource, Quick, Searched } from "@wirecat/cli-core/mail"
import { type FetchMessageObject, ImapFlow, type ListResponse } from "imapflow"

export interface ImapEndpoint {
  host: string
  port: number
  /** `plain` is for a local test server only; no profile can ask for it. */
  security: "tls" | "starttls" | "plain"
  login: string
}

export interface FolderInfo {
  path: string
  name: string
  role: string | null
  messages: number | null
  unseen: number | null
}

export interface AccountCheck {
  login: string
  capabilities: string[]
  features: Record<
    "idle" | "condstore" | "qresync" | "move" | "uidplus" | "compress" | "x_gm_ext_1" | "objectid",
    boolean
  >
  folders: number
}

export type ImapMailSource = MailSource & {
  check(): Promise<AccountCheck>
  folderList(): Promise<FolderInfo[]>
  close(): Promise<void>
}

/**
 * How the source spends a connection. The defaults come from measuring Yandex 360 (cli-testing,
 * performance/mail/yandex-imap-sync): a header FETCH takes 0.1 to 0.7 s per message and the time per message grows with
 * the size of the command, four connections read 2 to 3 times faster than one, and the server sometimes answers one
 * message with `NO [UNAVAILABLE]` and then closes the connection. So a call reads 15 messages on each of 4 connections:
 * a request of the budget (listBatch, fetchBatch) is 60 messages and takes about 9 s.
 */
export interface ImapTuning {
  /** Messages in one FETCH command. */
  listSize?: number
  /** UIDs in one FETCH that asks only for flags, date and size. */
  quickSize?: number
  fetchSize?: number
  /** Parallel connections one `list` or `fetchRaw` call spreads its commands over. */
  connections?: number
  /** One command's own limit; the socket limit only catches a dead line. */
  requestTimeoutMs?: number
  /** Waits before each retry of a command, jittered; the last one repeats. */
  backoffMs?: readonly number[]
  /** A hard ceiling per command; the budget and the deadline usually stop the retries first. */
  maxAttempts?: number
  /** A retry is a request of the run's budget: false stops the retries. */
  canRetry?: () => boolean
  /** Time left to the run's deadline; a retry that would not fit is not made. */
  timeLeftMs?: () => number | undefined
  signal?: AbortSignal
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  random?: () => number
}

export const IMAP_DEFAULTS = {
  listSize: 15,
  quickSize: 500,
  fetchSize: 15,
  connections: 4,
  requestTimeoutMs: 90_000,
  backoffMs: [1_000, 3_000, 10_000],
  maxAttempts: 8,
} as const

const HEADER_FIELDS = ["list-id", "list-unsubscribe", "precedence"]

const nap = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })

const digest = (id: string) => `imap:${createHash("sha256").update(id).digest("hex")}`

/** The raw error code (ECONNRESET, ETIMEDOUT) so a failed run can be diagnosed; never the server's text. */
const causeOf = (code: string | undefined) => (code && /^[A-Za-z0-9_.-]{1,40}$/.test(code) ? { cause_code: code } : {})

/** The server's error text can quote mail or names, so only its codes reach the caller. */
export const mapImapError = (error: unknown): CliError => {
  if (error instanceof CliError) return error
  const e = error as {
    code?: string
    authenticationFailed?: boolean
    responseStatus?: string
    responseText?: string
    serverResponseCode?: string
    throttleReset?: number
    response?: { attributes?: { section?: { value?: unknown }[] }[] }
  }
  // imapflow strips `[CODE]` from responseText and sets serverResponseCode on some commands only; the code is
  // always in the parsed response.
  const responseCode =
    e.serverResponseCode ?? String(e.response?.attributes?.[0]?.section?.[0]?.value ?? "").toUpperCase()
  if (e.authenticationFailed)
    return new CliError(
      "authentication_error",
      "the mail server refused the login; check the app password and that IMAP and app passwords are on in the account settings",
      { reason: "mail.login-refused" },
    )
  const throttled = e.code === "ETHROTTLE" || responseCode === "THROTTLED" || /throttl/i.test(e.responseText ?? "")
  if (throttled)
    return new CliError("rate_limited", "the mail server is limiting this account; wait and run the command again", {
      retryable: true,
      ...(typeof e.throttleReset === "number" ? { retry_after_ms: e.throttleReset } : {}),
    })
  if (
    e.code === "ETIMEDOUT" ||
    e.code === "ETIMEOUT" ||
    e.code === "ConnectionTimeout" ||
    e.code === "GreetingTimeout" ||
    e.code === "RequestTimeout" ||
    e.code === "CONNECT_TIMEOUT" ||
    e.code === "GREETING_TIMEOUT" ||
    e.code === "UPGRADE_TIMEOUT" ||
    e.code === "LockTimeout"
  )
    return new CliError("timeout", "the mail server did not answer in time", { retryable: true, ...causeOf(e.code) })
  if (
    e.code &&
    /^(ECONN|ENOTFOUND|EAI_|ENETUNREACH|EHOSTUNREACH|NoConnection|EPIPE|Closed|EConnectionClosed|UnexpectedTag|MissingTag|InvalidResponse|ResponseProcessingFailed|ParserError|PollFailed|TooManyResponses|NoMailboxSelected)/.test(
      e.code,
    )
  )
    return new CliError("network_error", "cannot reach the mail server", { retryable: true, ...causeOf(e.code) })
  if (responseCode === "UNAVAILABLE")
    return new CliError("provider_unavailable", "the mail server cannot answer this request now", {
      retryable: true,
      ...causeOf(responseCode),
    })
  return new CliError(
    "provider_error",
    `the mail server refused the request${e.responseStatus ? ` (${e.responseStatus})` : ""}`,
    causeOf(e.code ?? (responseCode || e.responseStatus)),
  )
}

const headersOf = (message: FetchMessageObject): MailHeaders => {
  const from = message.envelope?.from?.[0]
  const raw = message.headers ? message.headers.toString("utf8") : ""
  const field = (name: string) =>
    new RegExp(`^${name}:[ \\t]*(.*)$`, "im").exec(raw.replace(/\r?\n[ \t]+/g, " "))?.[1]?.trim()
  const listId = field("list-id")
  const bulk =
    listId !== undefined ||
    field("list-unsubscribe") !== undefined ||
    /^(bulk|list|junk)$/i.test(field("precedence") ?? "")
  return {
    ...(from?.address ? { from: from.address.toLowerCase() } : {}),
    ...(from?.name ? { fromName: from.name } : {}),
    ...(message.envelope?.subject ? { subject: message.envelope.subject } : {}),
    to: [...(message.envelope?.to ?? []), ...(message.envelope?.cc ?? [])].flatMap((a) =>
      a.address ? [a.address.toLowerCase()] : [],
    ),
    ...(listId ? { listId } : {}),
    bulk,
  }
}

const quickOf = (message: FetchMessageObject, folder: string): Quick => {
  const flags = message.flags ?? new Set<string>()
  const received = message.internalDate instanceof Date ? message.internalDate : new Date(message.internalDate ?? 0)
  return {
    uid: String(message.uid),
    receivedAt: received.toISOString(),
    folder,
    ...(message.size === undefined ? {} : { size: message.size }),
    seen: flags.has("\\Seen"),
    flagged: flags.has("\\Flagged"),
    labels: message.labels ? [...message.labels] : flags.has("\\Flagged") ? ["Starred"] : [],
  }
}

/** Without a stable id the Message-ID is the identity; without that, the UID, which means nothing without UIDVALIDITY. */
const idsOf = (messageId: string | undefined, folder: string, validity: string, uid: string) => {
  const identity = messageId ?? `uid:${folder}:${validity}:${uid}`
  return { messageId: digest(identity), threadId: digest(identity) }
}

const listedOf = (message: FetchMessageObject, folder: string, validity: string): Listed => {
  const ids = idsOf(message.envelope?.messageId, folder, validity, String(message.uid))
  return {
    ...quickOf(message, folder),
    ...(message.emailId ? { messageId: String(message.emailId) } : { messageId: ids.messageId }),
    threadId: message.threadId ? String(message.threadId) : ids.threadId,
    headers: headersOf(message),
  }
}

/**
 * The Message-ID as the server's ENVELOPE gives it (imapflow trims the value of the first header), so the id of a
 * message read as bytes is the id `list` gives it.
 */
const messageIdOf = (raw: Uint8Array): string | undefined => {
  const bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
  const ends = [bytes.indexOf("\r\n\r\n"), bytes.indexOf("\n\n")].filter((at) => at !== -1)
  const head = bytes.subarray(0, ends.length ? Math.min(...ends) : bytes.length).toString("utf8")
  return /^message-id:[ \t]*(.*)$/im.exec(head.replace(/\r?\n[ \t]+/g, " "))?.[1]?.trim() || undefined
}

const roleOf = (entry: ListResponse): string | null => {
  if (entry.path.toUpperCase() === "INBOX") return "inbox"
  return entry.specialUse ? entry.specialUse.replace(/^\\/, "").toLowerCase() : null
}

/** One IMAP source, its connections opened on first use and closed by `close`; the password never leaves this closure. */
export const imapSource = (endpoint: ImapEndpoint, password: string, tuning: ImapTuning = {}): ImapMailSource => {
  const { listSize, quickSize, fetchSize, connections, requestTimeoutMs, backoffMs, maxAttempts } = {
    ...IMAP_DEFAULTS,
    ...tuning,
  }
  const { canRetry, timeLeftMs, signal, sleep = nap, random = Math.random } = tuning
  const clients: (ImapFlow | undefined)[] = []
  /** Each folder's UIDVALIDITY as the run first saw it; a reconnect that finds another one stops the run. */
  const validities = new Map<string, string>()

  const connect = async (slot: number): Promise<ImapFlow> => {
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
    let timer: NodeJS.Timeout | undefined
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        drop(slot)
        reject(Object.assign(new Error("request timed out"), { code: "RequestTimeout" }))
      }, ms)
    })
    work.catch(() => {})
    try {
      return await Promise.race([work, expired])
    } finally {
      clearTimeout(timer)
    }
  }

  const once = async <T>(
    slot: number,
    folder: string | undefined,
    expected: string | undefined,
    work: (open: ImapFlow, validity: string) => Promise<T>,
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
   * out closes its connection, waits (jittered backoff) and tries on a fresh one, for as long as the run's budget
   * and deadline allow: a retry is a request of the budget, and none outlives the deadline.
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
        if (!transient || attempt >= maxAttempts || signal?.aborted) throw error
        const base = backoffMs[Math.min(attempt, backoffMs.length) - 1] ?? 10_000
        const wait = Math.round(base * (0.5 + random()))
        const left = timeLeftMs?.()
        if (left !== undefined && left <= wait) throw error
        if (canRetry && !canRetry()) throw error
        await sleep(wait, signal)
      }
    }
  }

  const inFolder = <T>(
    folder: string,
    work: (open: ImapFlow, validity: string) => Promise<T>,
    expected?: string,
    slot = 0,
  ): Promise<T> => retrying(slot, () => once(slot, folder, expected, work))

  /** Runs `work` over the batches on up to `connections` connections; the first failure stops the others. */
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

  const chunks = <T>(items: T[], size: number): T[][] => {
    const out: T[][] = []
    for (let start = 0; start < items.length; start += size) out.push(items.slice(start, start + size))
    return out
  }

  const search = async (since: Date, folder: string): Promise<Searched> => {
    const found = await inFolder(folder, async (open, validity) => {
      const uids = await open.search({ since }, { uid: true })
      // Message ids come free with OBJECTID and Gmail's extensions; without them the envelope costs a read per message.
      const quick = !open.capabilities.has("OBJECTID") && !open.capabilities.has("X-GM-EXT-1")
      return { ...(validity ? { validity } : {}), uids: (uids || []).map(String), ...(quick ? { quick } : {}) }
    })
    if (found.validity) validities.set(folder, found.validity)
    return found
  }

  const folderList = (): Promise<FolderInfo[]> =>
    retrying(0, async () => {
      const entries = await limited(
        0,
        connect(0).then((open) => open.list({ statusQuery: { messages: true, unseen: true } })),
      )
      return entries
        .filter((entry) => !entry.flags.has("\\Noselect") && !entry.flags.has("\\NonExistent"))
        .map((entry) => ({
          path: entry.path,
          name: entry.name,
          role: roleOf(entry),
          messages: entry.status?.messages ?? null,
          unseen: entry.status?.unseen ?? null,
        }))
    })

  return {
    listBatch: listSize * connections,
    fetchBatch: fetchSize * connections,
    search,

    present: (uids, folder) =>
      inFolder(folder, async (open) => {
        if (uids.length === 0) return []
        const held = new Set((await open.search({ uid: uids.join(",") }, { uid: true })) || [])
        return uids.filter((uid) => held.has(Number(uid)))
      }),

    folders: async () => {
      const entries = await folderList()
      const role = (...names: string[]) => entries.find((entry) => entry.role && names.includes(entry.role))?.path
      return { all: role("all", "archive") ?? "INBOX", trash: role("trash") ?? "Trash" }
    },

    list: async (since, folder, options) => {
      const searched = options?.searched ?? (await search(since, folder))
      if (!searched.validity) throw new CliError("invalid_response", "IMAP did not report UIDVALIDITY")
      const validity = searched.validity
      validities.set(folder, validity)
      // A message the server answers with `NO [UNAVAILABLE]` is simply absent here; the sync asks for it again later.
      const listing = (batches: string[][]) =>
        spread(
          folder,
          batches,
          (open, batch) =>
            open.fetchAll(
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
            ),
          validity,
          (error) => {
            const mapped = mapImapError(error)
            if (mapped.code !== "provider_unavailable") throw mapped
            return mapped
          },
        )
      const batches = chunks(searched.uids, listSize)
      const parts = await listing(batches)
      const messages: FetchMessageObject[] = []
      for (const [index, part] of parts.entries()) {
        if (!(part instanceof Error)) messages.push(...part)
        // Yandex refuses even the headers of a message it can never read, and with it the whole FETCH.
        else if ((batches[index] as string[]).length > 1)
          for (const single of await listing((batches[index] as string[]).map((uid) => [uid])))
            if (!(single instanceof Error)) messages.push(...single)
      }
      return messages.map((message) => listedOf(message, folder, validity))
    },

    quick: async (_since, folder, { searched }) => {
      if (!searched.validity) throw new CliError("invalid_response", "IMAP did not report UIDVALIDITY")
      const validity = searched.validity
      validities.set(folder, validity)
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
      const validity = validities.get(item.folder ?? "INBOX") ?? ""
      return idsOf(messageIdOf(raw), item.folder ?? "INBOX", validity, item.uid)
    },

    fetchRaw: async (items) => {
      const read = new Map<Quick, Uint8Array | Error>()
      const byFolder = new Map<string, Quick[]>()
      for (const item of items)
        byFolder.set(item.folder ?? "INBOX", [...(byFolder.get(item.folder ?? "INBOX") ?? []), item])
      const bodies = (folder: string, batches: Quick[][]) =>
        spread(
          folder,
          batches,
          async (open, batch) => {
            const found = new Map<string, Uint8Array>()
            const messages = await open.fetchAll(
              batch.map(({ uid }) => uid).join(","),
              { uid: true, source: true },
              { uid: true },
            )
            for (const message of messages) if (message.source) found.set(String(message.uid), message.source)
            return found
          },
          undefined,
          (error) => {
            // A throttled or dropped connection fails the whole run; one unreadable batch costs only itself.
            const mapped = mapImapError(error)
            if (["rate_limited", "authentication_error", "network_error", "timeout"].includes(mapped.code)) throw mapped
            return mapped
          },
        )
      for (const [folder, group] of byFolder) {
        const batches = chunks(group, fetchSize)
        const answers = await bodies(folder, batches)
        for (const [index, batch] of batches.entries()) {
          let answer = answers[index]
          // Yandex refuses a whole FETCH when one of its messages cannot be read; one by one, only that one is lost.
          if (answer instanceof CliError && answer.code === "provider_unavailable" && batch.length > 1) {
            const singles = await bodies(
              folder,
              batch.map((item) => [item]),
            )
            answer = new Map()
            for (const [at, item] of batch.entries()) {
              const single = singles[at]
              if (single instanceof Map && single.has(item.uid))
                answer.set(item.uid, single.get(item.uid) as Uint8Array)
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
      return items.map((item) => read.get(item) as Uint8Array | Error)
    },

    folderList,

    check: () =>
      retrying(0, async () => {
        const open = await limited(0, connect(0))
        const has = (name: string) => open.capabilities.has(name)
        const folders = (await limited(0, open.list())).length
        return {
          login: endpoint.login,
          capabilities: [...open.capabilities.keys()].sort(),
          features: {
            idle: has("IDLE"),
            condstore: has("CONDSTORE"),
            qresync: has("QRESYNC"),
            move: has("MOVE"),
            uidplus: has("UIDPLUS"),
            compress: has("COMPRESS=DEFLATE"),
            x_gm_ext_1: has("X-GM-EXT-1"),
            objectid: has("OBJECTID"),
          },
          folders,
        }
      }),

    close: async () => {
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
