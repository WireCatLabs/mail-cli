import type { KeyringStore } from "@wirecat/cli-base"
import { CliError } from "@wirecat/cli-base"
import { type BaseEnvironment, environmentOf, type GlobalFlags } from "@wirecat/cli-core/cli"
import type { Command } from "commander"
import { configuration } from "../config.js"
import type { DiscoveryDeps } from "../discovery.js"
import { IDENTITY } from "../identity.js"
import {
  type MailCredential,
  type MailEndpoint,
  type OpenBackend,
  passwordCredential,
  type RunBounds,
} from "../mail/backend.js"
import { imapBackend } from "../mail/imap/index.js"
import { microsoftClient, type OAuthKind, oauthCredential, oauthKeeper } from "../oauth.js"
import { providerFor } from "../providers.js"
import { type LookupHimalaya, type PasswordSource, passwordStore } from "../secret.js"

/** What a test hands `run()` in place of the network, the keyring and `secret-tool`. */
export interface MailEnvironment extends BaseEnvironment {
  keyring?: KeyringStore
  himalaya?: LookupHimalaya
  discovery?: DiscoveryDeps
  /** Opens the mailbox in place of IMAP; a test hands in one on its fake server. */
  backend?: OpenBackend
  /** The OAuth token endpoint and the browser, replaced in tests. */
  fetch?: typeof fetch
  openBrowser?: (url: string) => Promise<void>
}

export const contextOf = (command: Command) => {
  const environment = environmentOf<MailEnvironment>(command)
  const env = environment.env ?? process.env
  const flags = command.optsWithGlobals<GlobalFlags>()
  const settings = configuration.resolveSettings(flags, { env })
  return { environment, env, flags, settings, profile: settings.profile }
}

export const refuseOffline = (flags: GlobalFlags) => {
  if (flags.offline) throw new CliError("permission_error", "this needs the mail server; leave out --offline")
}

export const endpointOf = (settings: ReturnType<typeof contextOf>["settings"]): MailEndpoint => {
  const { address, login, host, port, security } = settings.mailbox
  if (!address || !host || !port || !security)
    throw new CliError(
      "configuration_error",
      `profile ${settings.profile} has no mail server; run \`${IDENTITY.command} ${settings.profile} session start --address <email>\``,
    )
  const smtp = smtpOf(settings.mailbox)
  return { host, port, security, login: login ?? address, ...(smtp ? { smtp } : {}) }
}

/** The profile's own submission server, else the one the registry knows for its provider. */
const smtpOf = (mailbox: ReturnType<typeof contextOf>["settings"]["mailbox"]) => {
  const known = mailbox.address ? providerFor(mailbox.address, mailbox.host)?.smtp : undefined
  const host = mailbox.smtp?.host ?? known?.host
  const port = mailbox.smtp?.port ?? known?.port
  const security = mailbox.smtp?.security ?? known?.security
  return host && port && security ? { host, port, security } : undefined
}

export const passwordsOf = (context: ReturnType<typeof contextOf>) =>
  passwordStore({
    env: context.env,
    profile: context.profile,
    keyring: context.environment.keyring,
    himalaya: context.environment.himalaya,
  })

/** The OAuth provider a profile signs in with, from its provider in the registry: Outlook and Microsoft 365. */
export const oauthKindOf = (mailbox: ReturnType<typeof contextOf>["settings"]["mailbox"]): OAuthKind | undefined =>
  mailbox.address ? providerFor(mailbox.address, mailbox.host)?.oauth : undefined

/** A profile's OAuth sign-in, refreshed as each connect asks; nothing is read until a login needs a token. */
export const oauthKeeperOf = (context: ReturnType<typeof contextOf>, kind: OAuthKind) => {
  const { mailbox } = context.settings
  let client: { clientId: string }
  try {
    client = microsoftClient(mailbox).client
  } catch {
    // A saved sign-in refreshes with the app it was made with, which the entry records.
    client = { clientId: "" }
  }
  return oauthKeeper({
    env: context.env,
    profile: context.profile,
    kind,
    client,
    keyring: context.environment.keyring,
    fetch: context.environment.fetch,
    signal: context.environment.signal,
  })
}

/** The profile's credential by its `auth`: the stored app password, or its OAuth sign-in. */
export const credentialOf = async (
  context: ReturnType<typeof contextOf>,
): Promise<{ credential: MailCredential; passwordFrom?: PasswordSource }> => {
  const { mailbox } = context.settings
  if (mailbox.auth === "oauth") {
    const kind = oauthKindOf(mailbox)
    if (!kind)
      throw new CliError(
        "configuration_error",
        `profile ${context.profile} signs in with OAuth, which mail can do for Outlook and Microsoft 365 only`,
      )
    return { credential: oauthCredential(oauthKeeperOf(context, kind), kind, context.profile) }
  }
  const stored = await passwordsOf(context).read()
  if (stored === undefined)
    throw new CliError(
      "authentication_error",
      `no app password for profile ${context.profile}; run \`${IDENTITY.command} ${context.profile} session start\``,
      { reason: "mail.no-password" },
    )
  return { credential: passwordCredential(stored.secret), passwordFrom: stored.source }
}

/** A retry that would end after the run's deadline is not made; this much is kept back for saving and answering. */
const RETRY_MARGIN_MS = 3_000

export interface OpenMailOptions {
  /** A server not saved in the profile yet: `session start` checks it before saving it. */
  endpoint?: MailEndpoint
  /** A password just typed or a token just received, not read from the keyring. */
  credential?: MailCredential
  canRetry?: () => boolean
}

/**
 * The one way a command opens the mailbox: bound by the run's deadline and abort, handed to the runner so a timeout
 * or a signal closes it too (WC-LIFE-3). The caller still closes it when done.
 */
export const openMail = async (context: ReturnType<typeof contextOf>, options: OpenMailOptions = {}) => {
  const { deadline, signal } = context.environment
  const endpoint = options.endpoint ?? endpointOf(context.settings)
  const { credential, passwordFrom } = options.credential
    ? { credential: options.credential, passwordFrom: undefined }
    : await credentialOf(context)
  const bounds: RunBounds = {
    timeLeftMs: () => {
      const now = deadline?.()
      return now ? now.endsAt - Date.now() - RETRY_MARGIN_MS : undefined
    },
    ...(signal ? { signal } : {}),
    ...(options.canRetry ? { canRetry: options.canRetry } : {}),
  }
  const backend = (context.environment.backend ?? imapBackend)(endpoint, credential, bounds)
  context.environment.trackCloseable?.(backend)
  return { backend, endpoint, passwordFrom }
}

export const collect = (value: string, previous: string[] = []): string[] => [...previous, value]
