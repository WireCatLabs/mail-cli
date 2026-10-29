import { CliError } from "@wirecat/cli-base"
import { type Discovery, discover, discoverByName, domainOf, type Security } from "../discovery.js"
import { GENERIC_PREPARE } from "../providers.js"
import type { MailEnvironment } from "./context.js"

export interface MailboxFlags {
  provider?: string
  host?: string
  port?: string
  security?: Security
  login?: string
  folder?: string[]
}

export const securityOf = (value: string): Security => {
  if (value !== "tls" && value !== "starttls")
    throw new CliError("validation_error", "--security takes tls or starttls; a plain connection is refused")
  return value
}

export const portOf = (value: string): number => {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new CliError("validation_error", "--port takes a port number")
  return port
}

/** Asks at a terminal which built-in provider hosts the address; an empty answer gives up. */
export type Pick = () => Promise<string | undefined>

const discovered = async (address: string, flags: MailboxFlags, environment: MailEnvironment, pick?: Pick) => {
  if (flags.provider) return discoverByName(address, flags.provider)
  try {
    return await discover(
      address,
      environment.discovery ?? { ...(environment.signal ? { signal: environment.signal } : {}) },
    )
  } catch (error) {
    if (!(error instanceof CliError) || error.code !== "not_found" || !pick) throw error
    const name = await pick()
    if (!name) throw error
    return discoverByName(address, name)
  }
}

export const chosen = async (
  address: string,
  flags: MailboxFlags,
  environment: MailEnvironment,
  pick?: Pick,
): Promise<Discovery> => {
  if (!flags.host) {
    const found = await discovered(address, flags, environment, pick)
    return {
      ...found,
      ...(flags.login ? { login: flags.login } : {}),
      imap: {
        ...found.imap,
        ...(flags.port ? { port: portOf(flags.port) } : {}),
        ...(flags.security ? { security: flags.security } : {}),
      },
    }
  }
  domainOf(address)
  return {
    address,
    provider: "custom",
    imap: { host: flags.host, port: flags.port ? portOf(flags.port) : 993, security: flags.security ?? "tls" },
    login: flags.login ?? address,
    auth: "app-password",
    found_by: "built-in",
    prepare: GENERIC_PREPARE,
  }
}
