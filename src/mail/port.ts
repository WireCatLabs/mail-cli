// A stand-in for the `MailSource` port that cli-core is about to export from `./mail`. It copies the shape of
// cli-memo's `src/mail/source.ts` (mbox-only members left out), so moving to the cli-core type is a one-import change.

export interface MailHeaders {
  from?: string
  fromName?: string
  subject?: string
  to: string[]
  listId?: string
  /** List-Id, List-Unsubscribe or `Precedence: bulk|list|junk`: mail sent to many, not written to one. */
  bulk: boolean
}

export interface Listed {
  uid: string
  /** Stable across folders: the server's own email id, or a hash of the Message-ID header. */
  messageId: string
  threadId: string
  receivedAt: string
  folder?: string
  labels?: string[]
  seen?: boolean
  flagged?: boolean
  size?: number
  headers?: MailHeaders
}

export interface Searched {
  /** Absent when the server does not say; then no UID is trusted across runs. */
  validity?: string
  uids: string[]
}

export interface MailSource {
  list(since: Date, folder: string, options?: { headers?: boolean; searched?: Searched }): Promise<Listed[]>
  search?(since: Date, folder: string): Promise<Searched>
  find?(messageIds: readonly string[], folder: string, options?: { headers?: boolean }): Promise<Listed[]>
  move?(
    messageIds: readonly string[],
    from: string,
    to: string,
    known?: ReadonlyMap<string, string>,
  ): Promise<{ moved: string[]; missing: string[] }>
  folders?(): Promise<{ all: string; trash: string }>
  present?(uids: readonly string[], folder: string): Promise<string[]>
  label?(messageIds: readonly string[], folder: string, labels: readonly string[]): Promise<void>
  /** Each item's raw RFC 5322 bytes, in order; one that could not be read is an Error, not a failed call. */
  fetchRaw(items: Listed[]): Promise<(Uint8Array | Error)[]>
}
