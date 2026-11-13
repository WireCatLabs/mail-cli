import { mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { CliError, isCliError, isMovedRun, type KeyringStore, resolvePaths, systemKeyring } from "@wirecat/cli-base"
import { hostFetch } from "@wirecat/cli-base/http"
import { type AppSource, googleApp, microsoftApp } from "@wirecat/cli-core/constants"
import { acquireLock, type FileLock, writeFileAtomic } from "@wirecat/cli-core/files"
import {
  credentialStorage,
  googleProvider,
  type OAuthClient,
  type OAuthProvider,
  oauthAccount,
  standardCodec,
  type TokenCodec,
  type TokenKeeper,
  type TokenStorage,
  tokenKeeper,
} from "@wirecat/cli-core/oauth"
import * as v from "valibot"
import type { Mailbox } from "./config.js"
import { DESKTOP, IDENTITY } from "./identity.js"
import type { MailCredential } from "./mail/backend.js"

export type OAuthKind = "microsoft" | "google"

export const OAUTH_GUIDE = "https://github.com/WireCatLabs/mail-cli/blob/main/docs/oauth-microsoft.md"

export const MICROSOFT_IMAP_SCOPE = "https://outlook.office.com/IMAP.AccessAsUser.All"
export const MICROSOFT_SMTP_SCOPE = "https://outlook.office.com/SMTP.Send"
/** IMAP and SMTP are one resource, so one token covers both; offline_access brings the refresh token. */
export const MICROSOFT_SCOPES = ["offline_access", MICROSOFT_IMAP_SCOPE, MICROSOFT_SMTP_SCOPE] as const

export const GOOGLE_GUIDE = "https://github.com/WireCatLabs/mail-cli/blob/main/docs/oauth-google.md"
/** The only scope Gmail gives IMAP and SMTP: https://developers.google.com/workspace/gmail/imap/xoauth2-protocol */
export const GOOGLE_MAIL_SCOPE = "https://mail.google.com/"
export const GOOGLE_SCOPES = ["openid", "email", GOOGLE_MAIL_SCOPE] as const

/** What each scope lets mail do, shown before the browser opens. */
export const SCOPE_WORDS: Record<string, string> = {
  offline_access: "stay signed in, so a scheduled sync needs no new sign-in",
  [MICROSOFT_IMAP_SCOPE]: "read and change your mail over IMAP",
  [MICROSOFT_SMTP_SCOPE]: "send mail as you over SMTP",
  openid: "know which account signed in",
  email: "see its address, to check it is this mailbox",
  [GOOGLE_MAIL_SCOPE]: "read, change and send your Gmail over IMAP and SMTP",
}

export const OAUTH_NAMES: Record<OAuthKind, string> = { microsoft: "Microsoft", google: "Google" }
export const scopesOf = (kind: OAuthKind): readonly string[] =>
  kind === "microsoft" ? MICROSOFT_SCOPES : GOOGLE_SCOPES
/** The scope without which a profile cannot send. */
export const sendScopeOf = (kind: OAuthKind) => (kind === "microsoft" ? MICROSOFT_SMTP_SCOPE : GOOGLE_MAIL_SCOPE)

// https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow: a public client sends no secret,
// and `common` takes work, school and personal accounts. Microsoft ignores the port only for `localhost`.
const microsoftProvider = (client: OAuthClient, address?: string): OAuthProvider => ({
  id: "microsoft",
  name: "Microsoft",
  authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  client,
  redirect: { kind: "loopback", host: "localhost" },
  authorizeParams: { prompt: "select_account", ...(address ? { login_hint: address } : {}) },
})

const standardGoogle = standardCodec("google")
const entryObject = (text: string): Record<string, unknown> => {
  const value: unknown = JSON.parse(text)
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new CliError("authentication_error", "the saved sign-in cannot be read; sign in again", {
      reason: "oauth.invalid",
    })
  return { ...value }
}

/**
 * gcal's codec (gcal-cli src/google.ts): a Google Desktop client needs its secret to refresh, and the client file is
 * read once, at sign-in, so the entry keeps the secret. The third copy after gcal and drive (DEBT, journal).
 */
const googleCodec: TokenCodec = {
  decode: (raw) => {
    const stored = standardGoogle.decode(raw)
    const { clientSecret } = entryObject(raw)
    return typeof clientSecret === "string" && clientSecret
      ? { ...stored, client: { clientId: stored.client?.clientId ?? "", clientSecret } }
      : stored
  },
  encode: (input) => {
    const entry = entryObject(standardGoogle.encode(input))
    if (input.client.clientSecret) entry.clientSecret = input.client.clientSecret
    else delete entry.clientSecret
    return JSON.stringify(entry)
  },
}

/**
 * The Google app a Gmail sign-in uses: `--client-file`, `MAIL_GOOGLE_CLIENT_ID` (with `MAIL_GOOGLE_CLIENT_SECRET`),
 * the profile's `google_client_id`, then WireCat's app (WC-SECR-25).
 */
export const googleClient = (env: NodeJS.ProcessEnv, mailbox: Mailbox, file?: string, platform = process.platform) =>
  googleApp({ env, prefix: "MAIL", clientFile: file, configClientId: mailbox.googleClientId, platform })

/** The sign-in hosts only, through the network or the fetch a test hands in. */
export const signInFetch = (fetcher?: typeof fetch): typeof fetch =>
  hostFetch({ hosts: DESKTOP.hosts ?? [], ...(fetcher ? { fetch: fetcher } : {}) }) as typeof fetch

const UserInfo = v.object({ email: v.optional(v.string()), email_verified: v.optional(v.boolean()) })

/** The address Google signed in, from OpenID userinfo; the token goes in a header, so no failure prints it. */
export const googleAddress = async (accessToken: string, fetcher?: typeof fetch, signal?: AbortSignal) => {
  let response: Response
  try {
    response = await signInFetch(fetcher)("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      ...(signal ? { signal } : {}),
      redirect: "error",
    })
  } catch {
    throw new CliError("provider_unavailable", "Google did not answer the account lookup; try again", {
      retryable: true,
    })
  }
  if (!response.ok)
    throw new CliError("authentication_error", `Google refused the account lookup (HTTP ${response.status})`, {
      reason: "mail.google-account-refused",
    })
  const info = v.safeParse(UserInfo, await response.json().catch(() => undefined))
  const email = info.success ? info.output.email : undefined
  if (!email || (info.success && info.output.email_verified === false))
    throw new CliError("authentication_error", "Google gave no verified address for this account", {
      reason: "mail.google-account-refused",
    })
  return email.toLowerCase()
}

/**
 * The Microsoft app a sign-in uses: `MAIL_MICROSOFT_CLIENT_ID`, the profile's `microsoft_client_id`, then WireCat's
 * public client (WC-SECR-25). Only the owner sets the key (OWNER_ONLY).
 */
export const microsoftClient = (env: NodeJS.ProcessEnv, mailbox: Mailbox) =>
  microsoftApp({ env, prefix: "MAIL", configClientId: mailbox.microsoftClientId })

const paths = (env: NodeJS.ProcessEnv) => resolvePaths({ appName: IDENTITY.appName, prefix: IDENTITY.envPrefix, env })

export type CredentialStorage = "keyring" | "file"

export interface OAuthOptions {
  env: NodeJS.ProcessEnv
  profile: string
  kind: OAuthKind
  keyring?: KeyringStore | undefined
  /** Where a new sign-in goes; a saved one is read and refreshed where it is. */
  storage?: CredentialStorage | undefined
}

/** The entry `oauth:<provider>:<profile>` beside the profile's app password, under the same options (WC-SECR-24). */
export const oauthStorage = ({ env, profile, kind, keyring = systemKeyring, storage }: OAuthOptions): TokenStorage =>
  credentialStorage({
    credentials: {
      configDir: paths(env).config,
      service: IDENTITY.appName,
      storage: storage === "file" ? "file" : "auto",
      env,
      isolated: keyring === systemKeyring && isMovedRun({ appName: IDENTITY.appName, prefix: IDENTITY.envPrefix, env }),
      keyring,
    },
    account: oauthAccount(kind, profile),
    codec: kind === "google" ? googleCodec : standardCodec(kind),
  })

export interface KeeperOptions extends OAuthOptions {
  client: OAuthClient
  /** The command that signs this profile in again, named in a refusal. */
  signInCommand: string
  /** Sent as `login_hint`, so the provider offers the right account first. */
  address?: string | undefined
  fetch?: typeof fetch | undefined
  signal?: AbortSignal | undefined
}

/** One profile's sign-in, refreshed under a lock every mail process shares; a refresh uses the app it signed in with. */
export const oauthKeeper = (options: KeeperOptions): TokenKeeper =>
  tokenKeeper({
    provider:
      options.kind === "google"
        ? googleProvider(options.client, options.address ? { loginHint: options.address } : {})
        : microsoftProvider(options.client, options.address),
    storage: oauthStorage(options),
    lockDir: paths(options.env).config,
    fetch: signInFetch(options.fetch),
    signInCommand: options.signInCommand,
    ...(options.signal ? { signal: options.signal } : {}),
  })

export const oauthCredential = (keeper: TokenKeeper, kind: OAuthKind, signInCommand: string): MailCredential => ({
  kind: "oauth",
  provider: kind,
  signInCommand,
  login: async ({ refresh = false } = {}) => ({ accessToken: await keeper.accessToken({ refresh }) }),
})

/** A token just received at sign-in, before anything is saved: a refusal fails the sign-in, nothing refreshes. */
export const tokenCredential = (accessToken: string, kind: OAuthKind): MailCredential => ({
  kind: "oauth",
  provider: kind,
  login: async () => ({ accessToken }),
})

/**
 * What `doctor` knows of each sign-in without opening the keyring: when it happened, with which app and scopes. Never
 * a token.
 */
export interface SignInRecord {
  provider: OAuthKind
  client: "wirecat" | "own"
  /** Where the app came from (WC-SECR-25); a record written before 0.15 has none. */
  source?: AppSource
  signed_in_at: string
  scopes: string[]
}

const SIGN_IN = v.looseObject({
  provider: v.picklist(["microsoft", "google"]),
  client: v.picklist(["wirecat", "own"]),
  source: v.optional(v.picklist(["flag", "env", "config", "constants"])),
  signed_in_at: v.string(),
  scopes: v.array(v.string()),
}) satisfies v.GenericSchema<unknown, SignInRecord>

const recordsPath = (env: NodeJS.ProcessEnv) => join(paths(env).state, "sign-ins.json")

export const signInRecords = (env: NodeJS.ProcessEnv): Record<string, SignInRecord> => {
  try {
    const value: unknown = JSON.parse(readFileSync(recordsPath(env), "utf8"))
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
    return Object.fromEntries(
      Object.entries(value).flatMap(([profile, record]) => {
        const read = v.safeParse(SIGN_IN, record)
        return read.success ? [[profile, read.output]] : []
      }),
    )
  } catch {
    return {}
  }
}

const LOCK_WAIT_MS = 10_000

/** The records' lock; another sign-in holds it for a moment only, so this waits for it. */
const lockRecords = async (env: NodeJS.ProcessEnv): Promise<FileLock> => {
  const started = Date.now()
  for (;;) {
    try {
      return await acquireLock(`${recordsPath(env)}.lock`)
    } catch (error) {
      if (!isCliError(error) || error.details.reason !== "file.locked" || Date.now() - started > LOCK_WAIT_MS)
        throw error
      await new Promise((done) => setTimeout(done, 25))
    }
  }
}

export const recordSignIn = async (env: NodeJS.ProcessEnv, profile: string, record: SignInRecord | undefined) => {
  if (!record && !(profile in signInRecords(env))) return
  const lock = await lockRecords(env)
  try {
    const records = signInRecords(env)
    if (record) records[profile] = record
    else if (profile in records) delete records[profile]
    else return
    mkdirSync(paths(env).state, { recursive: true, mode: 0o700 })
    await writeFileAtomic(recordsPath(env), `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 })
  } finally {
    await lock.release()
  }
}
