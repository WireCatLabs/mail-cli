import type { MailCriteria, MailSource, Searched } from "@wirecat/cli-core/mail"
import type { SearchSyntax } from "./imap/search.js"

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

/** Everything a command asks of one mailbox. cli-core's sync reads it as a `MailSource`. */
export interface MailBackend extends MailSource {
  check(): Promise<AccountCheck>
  folderList(): Promise<FolderInfo[]>
  /** The UIDs the server's own search finds in `folder`, in the provider's syntax. */
  serverQuery?(criteria: MailCriteria, folder: string, syntax: SearchSyntax): Promise<Searched>
  /** After this, every call fails; nothing reconnects. */
  close(): Promise<void>
}

export type OpenBackend = (endpoint: MailEndpoint, password: string, bounds?: RunBounds) => MailBackend
