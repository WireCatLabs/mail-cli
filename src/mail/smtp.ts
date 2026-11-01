import { CliError } from "@wirecat/cli-base"
import SMTPConnection from "nodemailer/lib/smtp-connection"
import type { MailEndpoint, MailSubmit, RunBounds, Submitted } from "./backend.js"

type SmtpError = Error & { code?: string; responseCode?: number; command?: string }

/** The server's reply can quote addresses, so only its codes reach the caller. */
const codes = (error: SmtpError) => ({
  ...(error.code && /^[A-Z0-9_]{1,40}$/.test(error.code) ? { cause_code: error.code } : {}),
  ...(error.responseCode ? { smtp_code: error.responseCode } : {}),
})

/** A failure before the message left: nothing was sent, so the owner may simply run the command again. */
const beforeSending = (error: SmtpError): CliError => {
  if (error.code === "EAUTH" || error.responseCode === 535)
    return new CliError(
      "authentication_error",
      "the submission server refused the login; check that the app password allows sending (SMTP) for this mailbox",
      { reason: "mail.smtp-login-refused", sent: false, ...codes(error) },
    )
  if (error.code === "ETIMEDOUT")
    return new CliError("timeout", "the submission server did not answer in time; nothing was sent", {
      sent: false,
      retryable: true,
      ...codes(error),
    })
  if (["ECONNECTION", "ESOCKET", "EDNS", "ETLS"].includes(error.code ?? ""))
    return new CliError("network_error", "cannot reach the submission server; nothing was sent", {
      sent: false,
      retryable: true,
      ...codes(error),
    })
  return new CliError("provider_error", "the submission server refused the connection; nothing was sent", {
    sent: false,
    ...codes(error),
  })
}

/** The server answered the envelope or the message with an error code: it took nothing. */
const refused = (error: SmtpError): CliError => {
  const temporary = error.responseCode !== undefined && error.responseCode >= 400 && error.responseCode < 500
  return new CliError(
    temporary ? "provider_unavailable" : "provider_error",
    temporary
      ? "the submission server cannot take the message now; nothing was sent, try again later"
      : "the submission server refused the message; nothing was sent",
    { sent: false, ...(temporary ? { retryable: true } : {}), ...codes(error) },
  )
}

const settle = <T>(start: (done: (error: SmtpError | null, value?: T) => void) => void): Promise<T> =>
  new Promise<T>((resolve, reject) => start((error, value) => (error ? reject(error) : resolve(value as T))))

/** SMTP submission with the profile's login and app password, one connection per message. */
export const smtpSubmit = (
  endpoint: Pick<MailEndpoint, "host" | "port" | "security" | "login">,
  password: string,
  bounds: RunBounds = {},
): MailSubmit => ({
  send: async ({ from, recipients, raw }): Promise<Submitted> => {
    const timeout = Math.max(1_000, Math.min(60_000, bounds.timeLeftMs?.() ?? 60_000))
    const connection = new SMTPConnection({
      host: endpoint.host,
      port: endpoint.port,
      secure: endpoint.security === "tls",
      requireTLS: endpoint.security === "starttls",
      ignoreTLS: endpoint.security === "plain",
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: timeout,
      logger: false,
    })
    // An 'error' event with no listener would end the process; each step's callback already rejects.
    connection.on("error", () => {})
    const abort = () => connection.close()
    bounds.signal?.addEventListener("abort", abort, { once: true })
    try {
      try {
        await settle<void>((done) => connection.connect((error) => done(error ?? null)))
        await settle<boolean>((done) => connection.login({ user: endpoint.login, pass: password }, done))
      } catch (error) {
        throw beforeSending(error as SmtpError)
      }
      try {
        const info = await settle<SMTPConnection.SentMessageInfo>((done) =>
          connection.send({ from, to: [...recipients] }, Buffer.from(raw), done),
        )
        return { accepted: info.accepted, rejected: info.rejected }
      } catch (raw) {
        const error = raw as SmtpError
        // The envelope is answered before the body goes; a message refused with a code was not taken either.
        if (error.code === "EENVELOPE" || (error.code === "EMESSAGE" && error.responseCode)) throw refused(error)
        throw new CliError(
          "outcome_unknown",
          "the line to the submission server broke while the message was going; it may have been sent — " +
            "look in Sent before sending it again",
          { retryable: false, ...codes(error) },
        )
      }
    } finally {
      bounds.signal?.removeEventListener("abort", abort)
      try {
        connection.quit()
      } catch {}
    }
  },
})
