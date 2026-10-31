import type { KeyringStore } from "@wirecat/cli-base"
import { CliError } from "@wirecat/cli-base"
import { type BaseEnvironment, environmentOf, type GlobalFlags } from "@wirecat/cli-core/cli"
import type { Command } from "commander"
import { configuration } from "../config.js"
import type { DiscoveryDeps } from "../discovery.js"
import { IDENTITY } from "../identity.js"
import { type ImapEndpoint, type ImapMailSource, type ImapTuning, imapSource } from "../mail/imap.js"
import { type LookupHimalaya, passwordStore } from "../secret.js"

/** What a test hands `run()` in place of the network, the keyring and `secret-tool`. */
export interface MailEnvironment extends BaseEnvironment {
  keyring?: KeyringStore
  himalaya?: LookupHimalaya
  discovery?: DiscoveryDeps
  connect?: (endpoint: ImapEndpoint, password: string, tuning?: ImapTuning) => ImapMailSource
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

export const endpointOf = (settings: ReturnType<typeof contextOf>["settings"]): ImapEndpoint => {
  const { address, login, host, port, security } = settings.mailbox
  if (!address || !host || !port || !security)
    throw new CliError(
      "configuration_error",
      `profile ${settings.profile} has no mail server; run \`${IDENTITY.command} ${settings.profile} session start --address <email>\``,
    )
  return { host, port, security, login: login ?? address }
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

/** An opened source for the profile, with the password read from the keyring; call `close` when done. */
export const openSource = async (context: ReturnType<typeof contextOf>, tuning: ImapTuning = {}) => {
  const { deadline, signal } = context.environment
  const endpoint = endpointOf(context.settings)
  const stored = await passwordsOf(context).read()
  if (!stored)
    throw new CliError(
      "authentication_error",
      `no app password for profile ${context.profile}; run \`${IDENTITY.command} ${context.profile} session start\``,
      { reason: "mail.no-password" },
    )
  const connect = context.environment.connect ?? imapSource
  const bounds: ImapTuning = {
    timeLeftMs: () => {
      const now = deadline?.()
      return now ? now.endsAt - Date.now() - RETRY_MARGIN_MS : undefined
    },
    ...(signal ? { signal } : {}),
  }
  const source = connect(endpoint, stored.secret, { ...bounds, ...tuning })
  context.environment.trackCloseable?.(source)
  return { source, endpoint, passwordFrom: stored.source }
}

export const collect = (value: string, previous: string[] = []): string[] => [...previous, value]
