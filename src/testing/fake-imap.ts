import { createServer, type Server, type Socket } from "node:net"

export interface FakeMessage {
  uid: number
  raw: string
  flags?: string[]
  date?: string
  /** RFC 8474 object ids, sent when the client asks for EMAILID or THREADID. */
  emailId?: string
  threadId?: string
}

export interface FakeFolder {
  name: string
  attributes?: string[]
  uidValidity?: number
  messages: FakeMessage[]
}

export interface FakeOptions {
  login: string
  password: string
  folders: FakeFolder[]
  capabilities?: string[]
  /** Answers every UID FETCH of message bodies with `NO [THROTTLED]`, as Gmail does under load. */
  throttleBodies?: boolean
}

export interface FakeImap {
  port: number
  /** Every command line received, with the LOGIN line left out. */
  commands: string[]
  close(): Promise<void>
}

const quote = (text: string) => `"${text.replace(/["\\]/g, "\\$&")}"`
const nil = (text: string | undefined) => (text === undefined ? "NIL" : quote(text))

const headerOf = (raw: string, name: string): string | undefined =>
  new RegExp(`^${name}:[ \\t]*(.*)$`, "im").exec(raw.replace(/\r?\n[ \t]+/g, " "))?.[1]?.trim()

const address = (value: string | undefined): string => {
  if (!value) return "NIL"
  const match = /^(?:(.*?)\s*)?<([^@>]+)@([^>]+)>$|^([^@\s]+)@(\S+)$/.exec(value)
  if (!match) return "NIL"
  const name = match[1]?.replace(/^"|"$/g, "")
  return `((${nil(name || undefined)} NIL ${nil(match[2] ?? match[4])} ${nil(match[3] ?? match[5])}))`
}

const envelope = (raw: string): string =>
  `(${nil(headerOf(raw, "date"))} ${nil(headerOf(raw, "subject"))} ${address(headerOf(raw, "from"))} ${address(headerOf(raw, "from"))} ` +
  `${address(headerOf(raw, "from"))} ${address(headerOf(raw, "to"))} ${address(headerOf(raw, "cc"))} NIL NIL ${nil(headerOf(raw, "message-id"))})`

const literal = (text: string) => `{${Buffer.byteLength(text)}}\r\n${text}`

const headerBlock = (raw: string, fields: string[]): string => {
  const wanted = new Set(fields.map((field) => field.toLowerCase()))
  const lines =
    raw
      .split(/\r?\n\r?\n/)[0]
      ?.replace(/\r?\n[ \t]+/g, " ")
      .split(/\r?\n/) ?? []
  return `${lines.filter((line) => wanted.has(line.split(":")[0]?.toLowerCase() ?? "")).join("\r\n")}\r\n\r\n`
}

const uidsIn = (set: string, all: number[]): number[] =>
  set.split(",").flatMap((part) => {
    const [from, to] = part.split(":")
    const low = Number(from)
    const high = to === undefined ? low : to === "*" ? Math.max(...all) : Number(to)
    return all.filter((uid) => uid >= Math.min(low, high) && uid <= Math.max(low, high))
  })

export const startFakeImap = async (options: FakeOptions): Promise<FakeImap> => {
  const commands: string[] = []
  const capabilities = [
    "IMAP4rev1",
    "ID",
    "NAMESPACE",
    "UIDPLUS",
    "MOVE",
    "SPECIAL-USE",
    "IDLE",
    ...(options.folders.some(({ messages }) => messages.some(({ emailId }) => emailId)) ? ["OBJECTID"] : []),
    ...(options.capabilities ?? []),
  ]
  const sockets = new Set<Socket>()

  const serve = (socket: Socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
    socket.on("error", () => {})
    let buffer = Buffer.alloc(0)
    let selected: FakeFolder | undefined
    const send = (text: string) => socket.write(`${text}\r\n`)
    send(`* OK [CAPABILITY ${capabilities.join(" ")}] fake ready`)

    const folderNamed = (name: string) => options.folders.find((folder) => folder.name === name)
    const argument = (text: string) => /^"((?:[^"\\]|\\.)*)"|^(\S+)/.exec(text)

    const handle = (tag: string, line: string) => {
      const [verb = "", ...rest] = line.split(" ")
      const command = verb.toUpperCase()
      const tail = rest.join(" ")
      if (command === "LOGIN") {
        const match = /^"((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)"/.exec(tail)
        const ok = match?.[1] === options.login && match?.[2] === options.password
        return send(
          ok
            ? `${tag} OK [CAPABILITY ${capabilities.join(" ")}] logged in`
            : `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials`,
        )
      }
      commands.push(`${command} ${tail}`.trim())
      switch (command) {
        case "CAPABILITY":
          send(`* CAPABILITY ${capabilities.join(" ")}`)
          return send(`${tag} OK done`)
        case "ID":
          send("* ID NIL")
          return send(`${tag} OK done`)
        case "NAMESPACE":
          send('* NAMESPACE (("" "/")) NIL NIL')
          return send(`${tag} OK done`)
        case "LIST":
          for (const folder of options.folders)
            send(`* LIST (${["\\HasNoChildren", ...(folder.attributes ?? [])].join(" ")}) "/" ${quote(folder.name)}`)
          return send(`${tag} OK done`)
        case "STATUS": {
          const name = argument(tail)
          const folder = folderNamed(name?.[1] ?? name?.[2] ?? "")
          if (!folder) return send(`${tag} NO [NONEXISTENT] no such folder`)
          const unseen = folder.messages.filter((message) => !message.flags?.includes("\\Seen")).length
          send(`* STATUS ${quote(folder.name)} (MESSAGES ${folder.messages.length} UNSEEN ${unseen})`)
          return send(`${tag} OK done`)
        }
        case "SELECT":
        case "EXAMINE": {
          const name = argument(tail)
          const folder = folderNamed(name?.[1] ?? name?.[2] ?? "")
          if (!folder) return send(`${tag} NO [NONEXISTENT] no such folder`)
          selected = folder
          send(`* ${folder.messages.length} EXISTS`)
          send("* 0 RECENT")
          send("* FLAGS (\\Seen \\Flagged)")
          send(`* OK [UIDVALIDITY ${folder.uidValidity ?? 777}] ok`)
          send(`* OK [UIDNEXT ${Math.max(0, ...folder.messages.map((message) => message.uid)) + 1}] ok`)
          return send(`${tag} OK [${command === "SELECT" ? "READ-WRITE" : "READ-ONLY"}] done`)
        }
        case "UID": {
          const [sub = "", ...more] = rest
          if (sub.toUpperCase() === "SEARCH") {
            const all = (selected?.messages ?? []).map((message) => message.uid)
            const wanted = /^UID (\S+)$/i.exec(more.join(" "))?.[1]
            const found = wanted ? uidsIn(wanted, all) : all
            send(`* SEARCH ${found.join(" ")}`.trimEnd())
            return send(`${tag} OK done`)
          }
          if (sub.toUpperCase() === "FETCH") {
            const set = more[0] ?? ""
            const items = more.slice(1).join(" ")
            const wantsBody = /BODY(\.PEEK)?\[\]/i.test(items)
            if (wantsBody && options.throttleBodies) return send(`${tag} NO [THROTTLED] Too many commands`)
            const messages = selected?.messages ?? []
            for (const uid of uidsIn(
              set,
              messages.map((message) => message.uid),
            )) {
              const message = messages.find((one) => one.uid === uid)
              if (!message) continue
              const parts = [`UID ${uid}`]
              if (/FLAGS/i.test(items)) parts.push(`FLAGS (${(message.flags ?? []).join(" ")})`)
              if (/INTERNALDATE/i.test(items))
                parts.push(`INTERNALDATE "${message.date ?? "28-Oct-2026 10:00:00 +0000"}"`)
              if (message.emailId && /EMAILID/i.test(items)) parts.push(`EMAILID (${message.emailId})`)
              if (message.threadId && /THREADID/i.test(items)) parts.push(`THREADID (${message.threadId})`)
              if (/RFC822\.SIZE/i.test(items)) parts.push(`RFC822.SIZE ${Buffer.byteLength(message.raw)}`)
              if (/ENVELOPE/i.test(items)) parts.push(`ENVELOPE ${envelope(message.raw)}`)
              const fields = /BODY(?:\.PEEK)?\[HEADER\.FIELDS \(([^)]*)\)\]/i.exec(items)
              if (fields)
                parts.push(
                  `BODY[HEADER.FIELDS (${fields[1]})] ${literal(headerBlock(message.raw, (fields[1] ?? "").split(" ")))}`,
                )
              if (wantsBody) parts.push(`BODY[] ${literal(message.raw)}`)
              send(`* ${messages.indexOf(message) + 1} FETCH (${parts.join(" ")})`)
            }
            return send(`${tag} OK done`)
          }
          return send(`${tag} BAD unknown UID command`)
        }
        case "LOGOUT":
          send("* BYE bye")
          send(`${tag} OK done`)
          return socket.end()
        default:
          return send(`${tag} OK done`)
      }
    }

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        const end = buffer.indexOf("\r\n")
        if (end === -1) return
        const text = buffer.subarray(0, end).toString("utf8")
        buffer = buffer.subarray(end + 2)
        const [tag = "", ...words] = text.split(" ")
        if (tag) handle(tag, words.join(" "))
      }
    })
  }

  const server: Server = createServer(serve)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address_ = server.address()
  const port = typeof address_ === "object" && address_ ? address_.port : 0
  return {
    port,
    commands,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  }
}
