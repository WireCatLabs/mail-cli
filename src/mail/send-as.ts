import type { AccountKey, MessageStore } from "@wirecat/cli-core/store"
import * as v from "valibot"
import { signInFetch } from "../oauth.js"

/** Sync state under the mail account: the Gmail "send as" aliases last read, lower case, as a JSON array. */
export const SEND_AS_KEY = "mail_send_as"

const SEND_AS_URL = "https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs"

const SendAsList = v.object({
  sendAs: v.optional(
    v.array(
      v.object({
        sendAsEmail: v.string(),
        isPrimary: v.optional(v.boolean()),
        verificationStatus: v.optional(v.string()),
      }),
    ),
  ),
})

/**
 * The account's custom "from" addresses Gmail accepted, without the account's own:
 * https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.settings.sendAs/list. The
 * https://mail.google.com/ scope the sign-in already asks for allows it. The token goes in a header, so no failure
 * prints it.
 */
export const readSendAs = async (accessToken: string, fetcher?: typeof fetch, signal?: AbortSignal) => {
  const response = await signInFetch(fetcher)(SEND_AS_URL, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    ...(signal ? { signal } : {}),
    redirect: "error",
  })
  if (!response.ok) throw new Error(`Gmail answered HTTP ${response.status}`)
  const list = v.safeParse(SendAsList, await response.json().catch(() => undefined))
  if (!list.success) throw new Error("Gmail's answer is not a sendAs list")
  return [
    ...new Set(
      (list.output.sendAs ?? [])
        .filter(({ isPrimary, verificationStatus }) => !isPrimary && verificationStatus === "accepted")
        .map(({ sendAsEmail }) => sendAsEmail.trim().toLowerCase()),
    ),
  ].sort()
}

const savedOf = (value: string | undefined): string[] => {
  if (value === undefined) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []
  } catch {
    return []
  }
}

/** The send-as list the last sync read, so a run that does not ask Gmail counts the same addresses. */
export const savedSendAs = async (store: MessageStore, key: AccountKey): Promise<string[]> =>
  savedOf((await store.sync.syncState(key, SEND_AS_KEY))?.value)

/**
 * The Gmail aliases to count as the owner's this run. A read that fails keeps the last list read: the owner's mail
 * from an alias must not turn incoming because Gmail did not answer once.
 */
export const gmailAliases = async (
  store: MessageStore,
  key: AccountKey,
  read: () => Promise<string[]>,
): Promise<{ aliases: string[]; unread?: string }> => {
  const saved = await savedSendAs(store, key)
  let aliases: string[]
  try {
    aliases = await read()
  } catch (error) {
    return { aliases: saved, unread: error instanceof Error ? error.message : String(error) }
  }
  if (JSON.stringify(aliases) !== JSON.stringify(saved))
    await store.sync.setSyncState(key, SEND_AS_KEY, JSON.stringify(aliases))
  return { aliases }
}
