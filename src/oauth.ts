import { spawn } from "node:child_process"
import { mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { CliError, isMovedRun, type KeyringStore, resolvePaths, systemKeyring } from "@wirecat/cli-base"
import { writeFileAtomic } from "@wirecat/cli-core/files"
import {
  credentialStorage,
  type OAuthClient,
  type OAuthProvider,
  oauthAccount,
  standardCodec,
  type TokenKeeper,
  type TokenStorage,
  tokenKeeper,
} from "@wirecat/cli-core/oauth"
import type { Mailbox } from "./config.js"
import { IDENTITY } from "./identity.js"
import type { MailCredential } from "./mail/backend.js"

export type OAuthKind = "microsoft"

/**
 * WireCat's Microsoft app: a public client for any Entra tenant and personal accounts. Empty until WireCat registers
 * it (docs/oauth-microsoft.md); until then a sign-in needs `microsoft_client_id` in the config.
 */
export const WIRECAT_MICROSOFT_CLIENT_ID = ""

export const OAUTH_GUIDE = "https://github.com/WireCatLabs/mail-cli/blob/main/docs/oauth-microsoft.md"

export const MICROSOFT_IMAP_SCOPE = "https://outlook.office.com/IMAP.AccessAsUser.All"
export const MICROSOFT_SMTP_SCOPE = "https://outlook.office.com/SMTP.Send"
/** IMAP and SMTP are one resource, so one token covers both; offline_access brings the refresh token. */
export const MICROSOFT_SCOPES = ["offline_access", MICROSOFT_IMAP_SCOPE, MICROSOFT_SMTP_SCOPE] as const

/** What each scope lets mail do, shown before the browser opens. */
export const SCOPE_WORDS: Record<string, string> = {
  offline_access: "stay signed in, so a scheduled sync needs no new sign-in",
  [MICROSOFT_IMAP_SCOPE]: "read and change your mail over IMAP",
  [MICROSOFT_SMTP_SCOPE]: "send mail as you over SMTP",
}

// https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow: a public client sends no secret,
// and `common` takes work, school and personal accounts.
const microsoftProvider = (client: OAuthClient, address?: string): OAuthProvider => ({
  id: "microsoft",
  name: "Microsoft",
  authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  client,
  redirect: { kind: "loopback" },
  authorizeParams: { prompt: "select_account", ...(address ? { login_hint: address } : {}) },
})

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
    codec: standardCodec(kind),
  })

export const signInWords = (profile: string) => `${IDENTITY.command} ${profile} session start`

export interface KeeperOptions extends OAuthOptions {
  client: OAuthClient
  /** Sent as `login_hint`, so Microsoft offers the right account first. */
  address?: string | undefined
  fetch?: typeof fetch | undefined
  signal?: AbortSignal | undefined
}

/** One profile's sign-in, refreshed under a lock every mail process shares; a refresh uses the app it signed in with. */
export const oauthKeeper = (options: KeeperOptions): TokenKeeper =>
  tokenKeeper({
    provider: microsoftProvider(options.client, options.address),
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
export const systemBrowser = (url: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const [command, args]: [string, string[]] =
      process.platform === "darwin"
        ? ["open", [url]]
        : process.platform === "win32"
          ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
          : ["xdg-open", [url]]
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true })
    child.once("error", () => reject(new CliError("configuration_error", `could not start ${command}`)))
    child.once("spawn", () => {
      child.unref()
      resolve()
    })
  })
