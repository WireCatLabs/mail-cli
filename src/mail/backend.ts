import type { MailSource } from "@wirecat/cli-core/mail"

export interface MailEndpoint {
  host: string
  port: number
  /** `plain` is for a local test server only; no profile can ask for it. */
  security: "tls" | "starttls" | "plain"
  login: string
}

/** What the run lets a backend spend: a retry is a request of its budget, and none outlives its deadline. */
export interface RunBounds {
  canRetry?: () => boolean
  timeLeftMs?: () => number | undefined
  signal?: AbortSignal
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

/** A message's flags as the server holds them now; `labels` only on Gmail, in its own spelling (`\Inbox`, `Work`). */
export interface ServerState {
  flags: string[]
  labels?: string[]
  /** The Message-ID, to find the message again on a server that gives no new UID after a move. */
  messageId?: string
}

/** Where a move or copy put the messages: their UIDs in the target, and its UIDVALIDITY, where the server says. */
export interface Moved {
  uids: Map<number, number>
  validity?: string
}

/**
 * The changes a command makes to a mailbox. Every call on messages names the folder's UIDVALIDITY as it was read with
 * the UIDs: a server that changed it since is refused, so no UID lands on another message. None of these is retried:
 * a write that may have reached the server is not sent twice.
 */
export interface MailWrites {
  /**
   * The folder's UIDVALIDITY, and the UID there of each Gmail id (`emailIds`) or Message-ID (`messageIds`)
   * asked for, keyed by what was asked; one not there is left out.
   */
  locate(
    folder: string,
    ids: { emailIds?: readonly string[]; messageIds?: readonly string[] },
  ): Promise<{ validity: string; uids: Map<string, number> }>
  state(folder: string, validity: string, uids: readonly number[]): Promise<Map<number, ServerState>>
  flag(
    folder: string,
    validity: string,
    uids: readonly number[],
    change: { add?: string[]; remove?: string[] },
  ): Promise<void>
  /** Gmail labels, by `X-GM-LABELS`. */
  label(
    folder: string,
    validity: string,
    uids: readonly number[],
    change: { add?: string[]; remove?: string[] },
  ): Promise<void>
  /** Each moved UID's new UID in `to`, where the server says (UIDPLUS). */
  move(folder: string, validity: string, uids: readonly number[], to: string): Promise<Moved>
  copy(folder: string, validity: string, uids: readonly number[], to: string): Promise<Moved>
  /** `\Deleted` and UID EXPUNGE of exactly these UIDs: gone for good. Only undoing a copy calls it. */
  expunge(folder: string, validity: string, uids: readonly number[]): Promise<void>
  /** Stores a message the tool built, with its flags; the new UID and UIDVALIDITY where the server says (APPENDUID). */
  append(folder: string, raw: Uint8Array, flags: readonly string[]): Promise<{ uid?: number; validity?: string }>
  createFolder(path: string): Promise<void>
  renameFolder(path: string, to: string): Promise<void>
  deleteFolder(path: string): Promise<void>
}

/** Everything a command asks of one mailbox. cli-core's sync reads it as a `MailSource`. */
export interface MailBackend extends MailSource {
  check(): Promise<AccountCheck>
  folderList(): Promise<FolderInfo[]>
  /** Absent on a backend that cannot change the mailbox. */
  writes?: MailWrites
  /** After this, every call fails; nothing reconnects. */
  close(): Promise<void>
}

export type OpenBackend = (endpoint: MailEndpoint, password: string, bounds?: RunBounds) => MailBackend
