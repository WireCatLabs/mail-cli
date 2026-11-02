import { spawn } from "node:child_process"
import { mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { CliError, isMovedRun, type KeyringStore, resolvePaths, systemKeyring } from "@wirecat/cli-base"
import { privateFiles } from "@wirecat/cli-core/cli"
import { writeFileAtomic } from "@wirecat/cli-core/files"
import {
  credentialStorage,
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
import { IDENTITY } from "./identity.js"
import type { MailCredential } from "./mail/backend.js"

export type OAuthKind = "microsoft" | "google"

/** WireCat's Microsoft app: a public client for any Entra tenant and personal accounts (docs/oauth-microsoft.md). */
export const WIRECAT_MICROSOFT_CLIENT_ID = "f7f05d3a-b948-4d50-b3ce-59c816ce69e9"

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

const googleProvider = (client: OAuthClient, address?: string): OAuthProvider => ({
  id: "google",
  name: "Google",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  revokeUrl: "https://oauth2.googleapis.com/revoke",
  client,
  redirect: { kind: "loopback" },
  // Without offline access Google returns no refresh token; without consent it does not return one again.
  authorizeParams: {
    access_type: "offline",
    prompt: "select_account consent",
    ...(address ? { login_hint: address } : {}),
  },
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

const ClientFile = v.object({
  installed: v.object({ client_id: v.pipe(v.string(), v.minLength(1)), client_secret: v.optional(v.string()) }),
})

/** The owner's Desktop client: `--client-file` (private to the owner), else MAIL_GOOGLE_CLIENT_ID; no bundled one. */
export const googleClient = (env: NodeJS.ProcessEnv, file?: string, platform = process.platform): OAuthClient => {
  if (!file) {
    const clientId = env.MAIL_GOOGLE_CLIENT_ID
    const clientSecret = env.MAIL_GOOGLE_CLIENT_SECRET
    if (clientId) return { clientId, ...(clientSecret ? { clientSecret } : {}) }
    throw new CliError(
      "configuration_error",
      `Gmail over OAuth needs your own Google app: pass --client-file <Desktop client JSON> (steps: ${GOOGLE_GUIDE})`,
      { reason: "mail.oauth-no-client" },
    )
  }
  const mode = privateFiles({ files: [file], dirs: [] }, platform)
  if (mode.checked && !mode.ok)
    throw new CliError(
      "configuration_error",
      `the client file can be read by other users of this computer; run chmod 600 ${file} and try again`,
      { reason: "sign-in.client-file-open" },
    )
  try {
    const { installed } = v.parse(ClientFile, JSON.parse(readFileSync(file, "utf8")))
    return {
      clientId: installed.client_id,
      ...(installed.client_secret ? { clientSecret: installed.client_secret } : {}),
    }
  } catch {
    throw new CliError(
      "configuration_error",
      "could not read a Desktop app OAuth client JSON from the client file; its contents were not logged",
      { reason: "sign-in.client-file-invalid" },
    )
  }
}

const UserInfo = v.object({ email: v.optional(v.string()), email_verified: v.optional(v.boolean()) })

/** The address Google signed in, from OpenID userinfo; the token goes in a header, so no failure prints it. */
export const googleAddress = async (accessToken: string, fetcher: typeof fetch, signal?: AbortSignal) => {
  const timeout = AbortSignal.timeout(30_000)
  let response: Response
  try {
    response = await fetcher("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: "error",
    })
  } catch {
    throw new CliError("provider_unavailable", "Google did not answer the account lookup; try again", {
      retryable: true,
    })
  }
  if (!response.ok)
    throw new CliError("authentication_error", `Google refused the account lookup (HTTP ${response.status})`)
  const info = v.safeParse(UserInfo, await response.json().catch(() => undefined))
  const email = info.success ? info.output.email : undefined
  if (!email || (info.success && info.output.email_verified === false))
    throw new CliError("authentication_error", "Google gave no verified address for this account")
  return email.toLowerCase()
}

/** The owner's own Microsoft app when the config names one, else WireCat's; only the owner sets the key (OWNER_ONLY). */
export const microsoftClient = (mailbox: Mailbox): { client: OAuthClient; source: "wirecat" | "own" } => {
  const own = mailbox.microsoftClientId?.trim()
  if (own) return { client: { clientId: own }, source: own === WIRECAT_MICROSOFT_CLIENT_ID ? "wirecat" : "own" }
  if (WIRECAT_MICROSOFT_CLIENT_ID) return { client: { clientId: WIRECAT_MICROSOFT_CLIENT_ID }, source: "wirecat" }
  throw new CliError(
    "configuration_error",
    "this mail build has no Microsoft app to sign in with yet. Register your own (a free Microsoft Entra app, " +
      `steps: ${OAUTH_GUIDE}) and set its Application (client) ID once, in a terminal: ` +
      `\`${IDENTITY.command} config set --defaults microsoft_client_id <id>\``,
    { reason: "mail.oauth-no-client" },
  )
}

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

export const signInWords = (profile: string) => `${IDENTITY.command} ${profile} session start`

export interface KeeperOptions extends OAuthOptions {
  client: OAuthClient
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
        ? googleProvider(options.client, options.address)
        : microsoftProvider(options.client, options.address),
    storage: oauthStorage(options),
    lockDir: paths(options.env).config,
    fetch: options.fetch ?? globalThis.fetch,
    signInCommand: signInWords(options.profile),
    ...(options.signal ? { signal: options.signal } : {}),
  })

export const oauthCredential = (keeper: TokenKeeper, kind: OAuthKind, profile: string): MailCredential => ({
  kind: "oauth",
  provider: kind,
  signInCommand: signInWords(profile),
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
  signed_in_at: string
  scopes: string[]
}

const recordsPath = (env: NodeJS.ProcessEnv) => join(paths(env).state, "sign-ins.json")

export const signInRecords = (env: NodeJS.ProcessEnv): Record<string, SignInRecord> => {
  try {
    const value: unknown = JSON.parse(readFileSync(recordsPath(env), "utf8"))
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, SignInRecord>)
      : {}
  } catch {
    return {}
  }
}

export const recordSignIn = async (env: NodeJS.ProcessEnv, profile: string, record: SignInRecord | undefined) => {
  const records = signInRecords(env)
  if (record) records[profile] = record
  else if (profile in records) delete records[profile]
  else return
  mkdirSync(paths(env).state, { recursive: true })
  await writeFileAtomic(recordsPath(env), `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 })
}

/** The system browser; the sign-in link is printed too, so a failure here only means opening it by hand. */
export const systemBrowser = (url: string, platform = process.platform, start = spawn): Promise<void> =>
  new Promise((resolve, reject) => {
    const [command, args]: [string, string[]] =
      platform === "darwin"
        ? ["open", [url]]
        : platform === "win32"
          ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
          : ["xdg-open", [url]]
    const child = start(command, args, { detached: true, stdio: "ignore", windowsHide: true })
    child.once("error", () => reject(new CliError("configuration_error", `could not start ${command}`)))
    child.once("spawn", () => {
      child.unref()
      resolve()
    })
  })
