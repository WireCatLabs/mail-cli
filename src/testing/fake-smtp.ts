import { SMTPServer } from "smtp-server"

export interface Received {
  from: string
  recipients: string[]
  raw: string
}

export interface FakeSmtpOptions {
  login: string
  password: string
  /** OAuth access tokens taken over AUTH XOAUTH2, as Microsoft's and Gmail's submission servers do. */
  tokens?: string[]
  /** `drop`: the line breaks after the message was read and before the answer, so the outcome is unknown. */
  onData?: "drop" | { code: number; message: string }
}

export interface FakeSmtp {
  port: number
  received: Received[]
  /** Logins tried, right or wrong. */
  logins: number
  /** The access token of each XOAUTH2 login, in order. */
  tokensTried: string[]
  close(): Promise<void>
}

/** A local submission server on smtp-server: plain text, AUTH PLAIN/LOGIN, nothing relayed anywhere. */
export const startFakeSmtp = async (options: FakeSmtpOptions): Promise<FakeSmtp> => {
  const received: Received[] = []
  const state = { logins: 0 }
  const tokensTried: string[] = []
  const server = new SMTPServer({
    logger: false,
    disabledCommands: ["STARTTLS"],
    allowInsecureAuth: true,
    authMethods: options.tokens ? ["XOAUTH2"] : ["PLAIN", "LOGIN"],
    onAuth: (auth, _session, callback) => {
      state.logins += 1
      if (auth.method === "XOAUTH2") tokensTried.push(auth.accessToken ?? "")
      const accepted =
        auth.method === "XOAUTH2"
          ? (options.tokens ?? []).includes(auth.accessToken ?? "")
          : auth.password === options.password
      if (auth.username === options.login && accepted) callback(null, { user: auth.username })
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
    tokensTried,
    get logins() {
      return state.logins
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
