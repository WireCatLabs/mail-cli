import { SMTPServer } from "smtp-server"

export interface Received {
  from: string
  recipients: string[]
  raw: string
}

export interface FakeSmtpOptions {
  login: string
  password: string
  /** `drop`: the line breaks after the message was read and before the answer, so the outcome is unknown. */
  onData?: "drop" | { code: number; message: string }
}

export interface FakeSmtp {
  port: number
  received: Received[]
  /** Logins tried, right or wrong. */
  logins: number
  close(): Promise<void>
}

/** A local submission server on smtp-server: plain text, AUTH PLAIN/LOGIN, nothing relayed anywhere. */
export const startFakeSmtp = async (options: FakeSmtpOptions): Promise<FakeSmtp> => {
  const received: Received[] = []
  const state = { logins: 0 }
  const server = new SMTPServer({
    logger: false,
    disabledCommands: ["STARTTLS"],
    allowInsecureAuth: true,
    onAuth: (auth, _session, callback) => {
      state.logins += 1
      if (auth.username === options.login && auth.password === options.password) callback(null, { user: auth.username })
      else callback(Object.assign(new Error("Invalid credentials"), { responseCode: 535 }))
    },
    onData: (stream, session, callback) => {
      const chunks: Buffer[] = []
      stream.on("data", (chunk: Buffer) => chunks.push(chunk))
      stream.on("end", () => {
        const fail = options.onData
        if (fail === "drop") {
          for (const connection of server.connections) connection._socket?.destroy()
          return
        }
        if (fail) return callback(Object.assign(new Error(fail.message), { responseCode: fail.code }))
        received.push({
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "",
          recipients: session.envelope.rcptTo.map(({ address }) => address),
          raw: Buffer.concat(chunks).toString("utf8"),
        })
        callback()
      })
    },
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.server.address()
  const port = typeof address === "object" && address ? address.port : 0
  return {
    port,
    received,
    get logins() {
      return state.logins
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
