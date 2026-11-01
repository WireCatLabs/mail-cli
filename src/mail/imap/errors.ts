import { CliError } from "@wirecat/cli-base"

/** The raw error code (ECONNRESET, ETIMEDOUT) so a failed run can be diagnosed; never the server's text. */
const causeOf = (code: string | undefined) => (code && /^[A-Za-z0-9_.-]{1,40}$/.test(code) ? { cause_code: code } : {})

/** The server's error text can quote mail or names, so only its codes reach the caller. */
export const mapImapError = (error: unknown): CliError => {
  if (error instanceof CliError) return error
  // imapflow throws plain Errors with extra fields it does not type, and tests hand in bare objects.
  const e = error as {
    code?: string
    authenticationFailed?: boolean
    responseStatus?: string
    responseText?: string
    serverResponseCode?: string
    throttleReset?: number
    response?: { attributes?: { section?: { value?: unknown }[] }[] }
  }
  // imapflow strips `[CODE]` from responseText and sets serverResponseCode on some commands only; the code is
  // always in the parsed response.
  const responseCode =
    e.serverResponseCode ?? String(e.response?.attributes?.[0]?.section?.[0]?.value ?? "").toUpperCase()
  if (e.authenticationFailed)
    return new CliError(
      "authentication_error",
      "the mail server refused the login; check the app password and that IMAP and app passwords are on in the account settings",
      { reason: "mail.login-refused" },
    )
  const throttled = e.code === "ETHROTTLE" || responseCode === "THROTTLED" || /throttl/i.test(e.responseText ?? "")
  if (throttled)
    return new CliError("rate_limited", "the mail server is limiting this account; wait and run the command again", {
      retryable: true,
      ...(typeof e.throttleReset === "number" ? { retry_after_ms: e.throttleReset } : {}),
    })
  if (
    e.code === "ETIMEDOUT" ||
    e.code === "ETIMEOUT" ||
    e.code === "ConnectionTimeout" ||
    e.code === "GreetingTimeout" ||
    e.code === "RequestTimeout" ||
    e.code === "CONNECT_TIMEOUT" ||
    e.code === "GREETING_TIMEOUT" ||
    e.code === "UPGRADE_TIMEOUT" ||
    e.code === "LockTimeout"
  )
    return new CliError("timeout", "the mail server did not answer in time", { retryable: true, ...causeOf(e.code) })
  if (
    e.code &&
    /^(ECONN|ENOTFOUND|EAI_|ENETUNREACH|EHOSTUNREACH|NoConnection|EPIPE|Closed|EConnectionClosed|UnexpectedTag|MissingTag|InvalidResponse|ResponseProcessingFailed|ParserError|PollFailed|TooManyResponses|NoMailboxSelected)/.test(
      e.code,
    )
  )
    return new CliError("network_error", "cannot reach the mail server", { retryable: true, ...causeOf(e.code) })
  if (responseCode === "UNAVAILABLE")
    return new CliError("provider_unavailable", "the mail server cannot answer this request now", {
      retryable: true,
      ...causeOf(responseCode),
    })
  return new CliError(
    "provider_error",
    `the mail server refused the request${e.responseStatus ? ` (${e.responseStatus})` : ""}`,
    causeOf(e.code ?? (responseCode || e.responseStatus)),
  )
}
