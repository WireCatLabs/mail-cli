import type { KeyringStore } from "@wirecat/cli-base"
import { CliError } from "@wirecat/cli-base"
import { type BaseEnvironment, environmentOf, type GlobalFlags } from "@wirecat/cli-core/cli"
import { type Command, Option } from "commander"
import { configuration } from "../config.js"
import type { DiscoveryDeps } from "../discovery.js"
import { IDENTITY } from "../identity.js"
import type { MailEndpoint, OpenBackend, RunBounds } from "../mail/backend.js"
import { imapBackend } from "../mail/imap/index.js"
import { providerFor } from "../providers.js"
import { type LookupHimalaya, passwordStore } from "../secret.js"

/** What a test hands `run()` in place of the network, the keyring and `secret-tool`. */
export interface MailEnvironment extends BaseEnvironment {
  keyring?: KeyringStore
  himalaya?: LookupHimalaya
  discovery?: DiscoveryDeps
  /** Opens the mailbox in place of IMAP; a test hands in one on its fake server. */
  backend?: OpenBackend
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

/** A retry that would end after the run's deadline is not made; this much is kept back for saving and answering. */
const RETRY_MARGIN_MS = 3_000

export interface OpenMailOptions {
  /** A server not saved in the profile yet: `session start` checks it before saving it. */
  endpoint?: MailEndpoint
  /** A password just typed, not read from the keyring. */
  password?: string
  canRetry?: () => boolean
}

/**
 * The one way a command opens the mailbox: bound by the run's deadline and abort, handed to the runner so a timeout
 * or a signal closes it too (WC-LIFE-3). The caller still closes it when done.
 */
export const openMail = async (context: ReturnType<typeof contextOf>, options: OpenMailOptions = {}) => {
  const { deadline, signal } = context.environment
  const endpoint = options.endpoint ?? endpointOf(context.settings)
  const stored = options.password === undefined ? await passwordsOf(context).read() : undefined
  const password = options.password ?? stored?.secret
  if (password === undefined)
    throw new CliError(
      "authentication_error",
      `no app password for profile ${context.profile}; run \`${IDENTITY.command} ${context.profile} session start\``,
      { reason: "mail.no-password" },
    )
  const bounds: RunBounds = {
    timeLeftMs: () => {
      const now = deadline?.()
      return now ? now.endsAt - Date.now() - RETRY_MARGIN_MS : undefined
    },
    ...(signal ? { signal } : {}),
    ...(options.canRetry ? { canRetry: options.canRetry } : {}),
  }
  const backend = (context.environment.backend ?? imapBackend)(endpoint, password, bounds)
  context.environment.trackCloseable?.(backend)
  return { backend, endpoint, passwordFrom: stored?.source }
}

export const collect = (value: string, previous: string[] = []): string[] => [...previous, value]

/** The empty list as its default is what tells the MCP tool to take a list for the option, not one string. */
export const repeatable = (flags: string, description: string): Option =>
  new Option(flags, description).argParser(collect).default([], "none")
