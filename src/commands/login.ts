import { CliError, isCliError } from "@wirecat/cli-base"
import { IDENTITY } from "../identity.js"
import type { MailBackend } from "../mail/backend.js"
import type { Prepare } from "../providers.js"

const REFUSED = new Set([
  "mail.login-refused",
  "mail.oauth-refused",
  "mail.app-password-required",
  "mail.imap-disabled",
])

/** A refused login, with the provider's likely cause and where the steps are; any other error passes through. */
const explained = (error: unknown, prepare: Prepare): unknown => {
  if (!isCliError(error)) return error
  if (REFUSED.has(String(error.details.reason)))
    return new CliError(
      error.code,
      `${error.message}. Likely cause: ${prepare.refused} Run \`${IDENTITY.command} <profile> session start\` to see the steps again.`,
      error.details,
    )
  // At sign-in nothing has worked yet, so a server that does not answer is most likely a wrong host or port.
  if (error.code === "network_error" || error.code === "timeout")
    return new CliError("network_error", `${error.message}; check the server name and port`, {
      ...error.details,
      reason: "mail.host-unreachable",
    })
  return error
}

/** Logs in once and closes; the password is stored by the caller, only after this succeeds (WC-SECR-5). */
export const checkLogin = async (backend: MailBackend, prepare: Prepare) => {
  try {
    return await backend.check()
  } catch (error) {
    throw explained(error, prepare)
  } finally {
    await backend.close()
  }
}
