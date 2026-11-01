import { CliError, isCliError } from "@wirecat/cli-base"
import { IDENTITY } from "../identity.js"
import type { MailBackend, MailEndpoint } from "../mail/backend.js"
import type { Prepare } from "../providers.js"

/** A refused login, with the provider's likely cause and where the steps are; any other error passes through. */
const explained = (error: unknown, prepare: Prepare): unknown =>
  isCliError(error) && error.details.reason === "mail.login-refused"
    ? new CliError(
        error.code,
        `${error.message}. Likely cause: ${prepare.refused} Run \`${IDENTITY.command} <profile> session start\` to see the steps again.`,
        error.details,
      )
    : error

/** Logs in once and closes; the password is stored by the caller, only after this succeeds (WC-SECR-5). */
export const checkLogin = async (
  connect: (endpoint: MailEndpoint, password: string) => MailBackend,
  endpoint: MailEndpoint,
  password: string,
  prepare: Prepare,
) => {
  let source: MailBackend | undefined
  try {
    source = connect(endpoint, password)
    return await source.check()
  } catch (error) {
    throw explained(error, prepare)
  } finally {
    await source?.close()
  }
}
