import { CliError, isCliError } from "@wirecat/cli-base"
import { IDENTITY } from "../identity.js"
import type { ImapEndpoint, ImapMailSource } from "../mail/imap.js"
import type { Prepare } from "../providers.js"

/** A refused login, with the provider's likely cause and where the steps are; any other error passes through. */
const explained = (error: unknown, address: string, prepare: Prepare): unknown =>
  isCliError(error) && error.details.reason === "mail.login-refused"
    ? new CliError(
        error.code,
        `${error.message}. Likely cause: ${prepare.refused} \`${IDENTITY.command} setup ${address}\` shows the steps again.`,
        error.details,
      )
    : error

/** Logs in once and closes; the password is stored by the caller, only after this succeeds (WC-SECR-5). */
export const checkLogin = async (
  connect: (endpoint: ImapEndpoint, password: string) => ImapMailSource,
  endpoint: ImapEndpoint,
  password: string,
  address: string,
  prepare: Prepare,
) => {
  let source: ImapMailSource | undefined
  try {
    source = connect(endpoint, password)
    return await source.check()
  } catch (error) {
    throw explained(error, address, prepare)
  } finally {
    await source?.close()
  }
}
