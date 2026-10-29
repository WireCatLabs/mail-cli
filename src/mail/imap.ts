import { createHash } from "node:crypto"
import { CliError } from "@wirecat/cli-base"
import type { Listed, MailHeaders, MailSource, Searched } from "@wirecat/cli-core/mail"
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

const HEADER_FIELDS = ["list-id", "list-unsubscribe", "precedence"]
const LIST_BATCH = 50
const FETCH_BATCH = 25

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
  if (e.code === "ETIMEDOUT" || e.code === "ETIMEOUT" || e.code === "ConnectionTimeout" || e.code === "GreetingTimeout")
    return new CliError("timeout", "the mail server did not answer in time", { retryable: true, ...causeOf(e.code) })
  if (e.code && /^(ECONN|ENOTFOUND|EAI_|ENETUNREACH|EHOSTUNREACH|NoConnection|EPIPE)/.test(e.code))
    return new CliError("network_error", "cannot reach the mail server", { retryable: true, ...causeOf(e.code) })
  return new CliError(
    "provider_error",
    `the mail server refused the request${e.responseStatus ? ` (${e.responseStatus})` : ""}`,
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

const listedOf = (message: FetchMessageObject, folder: string, validity: string): Listed => {
  const messageId = message.envelope?.messageId
  // Without a stable id the Message-ID is the identity; without that, the UID, which means nothing without UIDVALIDITY.
  const identity = messageId ?? `uid:${folder}:${validity}:${message.uid}`
  const flags = message.flags ?? new Set<string>()
  const received = message.internalDate instanceof Date ? message.internalDate : new Date(message.internalDate ?? 0)
  return {
    uid: String(message.uid),
    messageId: message.emailId ? String(message.emailId) : digest(identity),
    threadId: message.threadId ? String(message.threadId) : digest(identity),
    receivedAt: received.toISOString(),
    folder,
    ...(message.size === undefined ? {} : { size: message.size }),
    seen: flags.has("\\Seen"),
    flagged: flags.has("\\Flagged"),
    labels: message.labels ? [...message.labels] : flags.has("\\Flagged") ? ["Starred"] : [],
    headers: headersOf(message),
  }
}

const roleOf = (entry: ListResponse): string | null => {
  if (entry.path.toUpperCase() === "INBOX") return "inbox"
  return entry.specialUse ? entry.specialUse.replace(/^\\/, "").toLowerCase() : null
}

/** One IMAP connection, opened on first use and closed by `close`; the password never leaves this closure. */
export const imapSource = (endpoint: ImapEndpoint, password: string): ImapMailSource => {
  let client: ImapFlow | undefined

  const connected = async (): Promise<ImapFlow> => {
    if (client?.usable) return client
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
      socketTimeout: 600000,
    })
    // An 'error' event with no listener would end the process, and the failing call already rejects.
    next.on("error", () => {})
    try {
      await next.connect()
    } catch (error) {
      throw mapImapError(error)
    }
    client = next
    return next
  }

  const once = async <T>(folder: string, work: (open: ImapFlow, validity: string) => Promise<T>): Promise<T> => {
    const open = await connected()
    try {
      const lock = await open.getMailboxLock(folder, { readOnly: true })
      try {
        const validity = open.mailbox ? String(open.mailbox.uidValidity) : ""
        return await work(open, validity)
      } finally {
        lock.release()
      }
    } catch (error) {
      throw mapImapError(error)
    }
  }

  // Every call here only reads, so one more try on a fresh connection after a dropped one is safe.
  const inFolder = async <T>(folder: string, work: (open: ImapFlow, validity: string) => Promise<T>): Promise<T> => {
    try {
      return await once(folder, work)
    } catch (error) {
      if (!(error instanceof CliError) || error.code !== "network_error") throw error
      client?.close()
      client = undefined
      return once(folder, work)
    }
  }

  const search = (since: Date, folder: string): Promise<Searched> =>
    inFolder(folder, async (open, validity) => {
      const uids = await open.search({ since }, { uid: true })
      return { ...(validity ? { validity } : {}), uids: (uids || []).map(String) }
    })

  const folderList = async (): Promise<FolderInfo[]> => {
    const open = await connected()
    try {
      const entries = await open.list({ statusQuery: { messages: true, unseen: true } })
      return entries
        .filter((entry) => !entry.flags.has("\\Noselect") && !entry.flags.has("\\NonExistent"))
        .map((entry) => ({
          path: entry.path,
          name: entry.name,
          role: roleOf(entry),
          messages: entry.status?.messages ?? null,
          unseen: entry.status?.unseen ?? null,
        }))
    } catch (error) {
      throw mapImapError(error)
    }
  }

  return {
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
      const listed: Listed[] = []
      // One call per batch: a dropped connection costs only that batch, and the folder must be the same one after it.
      for (let start = 0; start < searched.uids.length; start += LIST_BATCH) {
        const batch = searched.uids.slice(start, start + LIST_BATCH)
        const messages = await inFolder(folder, async (open, current) => {
          if (current !== validity)
            throw new CliError("invalid_response", "UIDVALIDITY changed during the run; run it again")
          return open.fetchAll(
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
        })
        for (const message of messages) listed.push(listedOf(message, folder, validity))
      }
      return listed
    },

    fetchRaw: async (items) => {
      const read = new Map<Listed, Uint8Array | Error>()
      const byFolder = new Map<string, Listed[]>()
      for (const item of items)
        byFolder.set(item.folder ?? "INBOX", [...(byFolder.get(item.folder ?? "INBOX") ?? []), item])
      for (const [folder, group] of byFolder)
        for (let start = 0; start < group.length; start += FETCH_BATCH) {
          const batch = group.slice(start, start + FETCH_BATCH)
          try {
            const sources = await inFolder(folder, async (open) => {
              const found = new Map<string, Uint8Array>()
              const messages = await open.fetchAll(
                batch.map(({ uid }) => uid).join(","),
                { uid: true, source: true },
                { uid: true },
              )
              for (const message of messages) if (message.source) found.set(String(message.uid), message.source)
              return found
            })
            for (const item of batch)
              read.set(item, sources.get(item.uid) ?? new CliError("not_found", `email ${item.uid} was not returned`))
          } catch (error) {
            // A throttled or dropped connection fails the whole run; one unreadable batch costs only itself.
            if (
              error instanceof CliError &&
              ["rate_limited", "authentication_error", "network_error", "timeout"].includes(error.code)
            )
              throw error
            for (const item of batch) read.set(item, error instanceof Error ? error : new Error(String(error)))
          }
        }
      return items.map((item) => read.get(item) as Uint8Array | Error)
    },

    folderList,

    check: async () => {
      const open = await connected()
      const has = (name: string) => open.capabilities.has(name)
      try {
        const folders = (await open.list()).length
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
      } catch (error) {
        throw mapImapError(error)
      }
    },

    close: async () => {
      const open = client
      client = undefined
      if (!open) return
      try {
        await open.logout()
      } catch {
        open.close()
      }
    },
  }
}
