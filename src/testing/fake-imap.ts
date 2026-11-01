import { createServer, type Server, type Socket } from "node:net"

export interface FakeMessage {
  uid: number
  raw: string
  flags?: string[]
  date?: string
  /** RFC 8474 object ids, sent when the client asks for EMAILID or THREADID; Gmail's X-GM-MSGID with `gmail`. */
  emailId?: string
  threadId?: string
  /** Gmail labels, as X-GM-LABELS gives them (`\\Inbox`, `Work`). */
  labels?: string[]
}

export interface FakeFolder {
  name: string
  attributes?: string[]
  uidValidity?: number
  /** A UID once given is never given again, as RFC 3501 has it; set from the messages when left out. */
  uidNext?: number
  messages: FakeMessage[]
}

export interface FakeOptions {
  login: string
  password: string
  /**
   * OAuth access tokens the server takes, as Microsoft and Gmail do: AUTHENTICATE XOAUTH2 with SASL-IR, plus
   * OAUTHBEARER with `oauthBearer`. The test may change the list while the server runs, as a revocation does.
   */
  tokens?: string[]
  oauthBearer?: boolean
  folders: FakeFolder[]
  capabilities?: string[]
  /** Answers every UID FETCH of message bodies with `NO [THROTTLED]`, as Gmail does under load. */
  throttleBodies?: boolean
  /** Drops the connection instead of answering this many UID SEARCH commands, as a flaky network does. */
  dropSearches?: number
  /** Never answers a UID SEARCH, as a server busy with a large folder does. */
  hangSearches?: boolean
  /** Answers every UID SEARCH with a tagged NO, as a server that cannot search a folder does. */
  refuseSearches?: boolean
  /** UIDs a FETCH answers with an untagged `NO [UNAVAILABLE]` instead of the message, as Yandex does; each once. */
  unavailableOnce?: number[]
  /** Closes the connection on this many UID FETCH commands, after answering the first of their messages. */
  dropFetches?: number
  /** Answers this many UID FETCH commands with a tagged `NO [UNAVAILABLE]`, as a busy backend does. */
  refuseFetches?: number
  /** UIDs whose body Yandex can never read: a body FETCH that names any of them is refused whole, every time. */
  brokenBodies?: number[]
  /** UIDs whose headers Yandex can never read either: a header FETCH that names any of them is refused whole. */
  brokenHeaders?: number[]
  /** Never answers a UID FETCH, so the request can only time out. */
  hangFetches?: boolean
  /** Changes the folder's UIDVALIDITY after this many connections have been dropped by `dropFetches`. */
  validityAfterDrop?: number
  /** Answers a UID SEARCH by criteria, literals inlined, as a server's own search does; `undefined` falls through. */
  search?: (criteria: string, folder: string) => number[] | undefined
  /**
   * Gmail: X-GM-EXT-1, ids and labels as X-GM-MSGID and X-GM-LABELS, and a mailbox where every message outside Trash
   * and Spam lives in All Mail and INBOX is only its `\\Inbox` label.
   */
  gmail?: boolean
  /** The folders take no keywords of their own: PERMANENTFLAGS without `\\*`, as some servers answer. */
  noKeywords?: boolean
  /** Folders whose STATUS gives UNSEEN but no MESSAGES count, as a server may answer. */
  uncounted?: string[]
}

export interface FakeImap {
  port: number
  /** Every command line received, with the LOGIN and AUTHENTICATE lines left out. */
  commands: string[]
  /** The access token of each AUTHENTICATE, accepted or not, in order. */
  tokensTried: string[]
  /** Client connections still open. */
  connections(): number
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

const uidsOf = (set: string): number[] =>
  set.split(",").flatMap((part) => {
    const [from, to] = part.split(":").map(Number)
    if (from === undefined || Number.isNaN(from)) return []
    const last = to === undefined || Number.isNaN(to) ? from : to
    return Array.from({ length: last - from + 1 }, (_, i) => from + i)
  })

/** The words of a command line: atoms, quoted strings and parentheses, as IMAP writes them. */
const tokens = (text: string): string[] => {
  const out: string[] = []
  for (let at = 0; at < text.length; ) {
    const c = text[at] as string
    if (c === " ") at++
    else if (c === "(" || c === ")") {
      out.push(c)
      at++
    } else if (c === '"') {
      let value = ""
      for (at++; at < text.length && text[at] !== '"'; at++) value += text[at] === "\\" ? text[++at] : text[at]
      out.push(value)
      at++
    } else {
      const end = text.slice(at).search(/[ ()]/)
      const word = end === -1 ? text.slice(at) : text.slice(at, at + end)
      out.push(word)
      at += word.length
    }
  }
  return out
}

type Test = (message: FakeMessage, all: number[]) => boolean

/** UID SEARCH criteria, as far as the tests and imapflow use them; date keys match every message. */
const criteria = (words: string[]): Test => {
  let at = 0
  const key = (): Test => {
    const word = (words[at++] ?? "").toUpperCase()
    if (word === "(") {
      const inner: Test[] = []
      while (at < words.length && words[at] !== ")") inner.push(key())
      at++
      return (message, all) => inner.every((one) => one(message, all))
    }
    if (word === "OR") {
      const left = key()
      const right = key()
      return (message, all) => left(message, all) || right(message, all)
    }
    if (word === "NOT") {
      const inner = key()
      return (message, all) => !inner(message, all)
    }
    if (word === "UID") {
      const set = words[at++] ?? ""
      return (message, all) => uidsIn(set, all).includes(message.uid)
    }
    if (word === "X-GM-MSGID" || word === "EMAILID") {
      const id = words[at++]
      return (message) => message.emailId === id
    }
    if (word === "HEADER") {
      const name = words[at++] ?? ""
      const value = (words[at++] ?? "").toLowerCase()
      return (message) => (headerOf(message.raw, name) ?? "").toLowerCase().includes(value)
    }
    if (word === "CHARSET" || ["SINCE", "BEFORE", "ON", "SENTSINCE", "SENTBEFORE"].includes(word)) {
      at++
      return () => true
    }
    return () => true
  }
  const all: Test[] = []
  while (at < words.length) all.push(key())
  return (message, uids) => all.every((one) => one(message, uids))
}

const listOf = (words: string[], from: number): { values: string[]; end: number } => {
  if (words[from] !== "(") return { values: [words[from] ?? ""], end: from + 1 }
  const values: string[] = []
  let at = from + 1
  for (; at < words.length && words[at] !== ")"; at++) values.push(words[at] as string)
  return { values, end: at + 1 }
}

const atomOrQuoted = (value: string) => (/^[\\$]?[\w.-]+$/.test(value) ? value : quote(value))

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
    ...(options.gmail
      ? ["X-GM-EXT-1"]
      : options.folders.some(({ messages }) => messages.some(({ emailId }) => emailId))
        ? ["OBJECTID"]
        : []),
    ...(options.tokens ? ["SASL-IR", "AUTH=XOAUTH2", ...(options.oauthBearer ? ["AUTH=OAUTHBEARER"] : [])] : []),
    ...(options.capabilities ?? []),
  ]
  const tokensTried: string[] = []
  for (const folder of options.folders) folder.uidNext ??= Math.max(0, ...folder.messages.map(({ uid }) => uid)) + 1
  const sockets = new Set<Socket>()
  let dropsLeft = options.dropSearches ?? 0
  let fetchDropsLeft = options.dropFetches ?? 0
  let refusalsLeft = options.refuseFetches ?? 0
  const unavailable = new Set(options.unavailableOnce ?? [])
  let validityShift = 0

  const serve = (socket: Socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
    socket.on("error", () => {})
    let buffer = Buffer.alloc(0)
    let selected: FakeFolder | undefined
    const send = (text: string) => socket.write(`${text}\r\n`)
    send(`* OK [CAPABILITY ${capabilities.join(" ")}] fake ready`)

    const folderNamed = (name: string) => options.folders.find((folder) => folder.name === name)
    const special = (attribute: string) => options.folders.find((folder) => folder.attributes?.includes(attribute))
    const nextUid = (folder: FakeFolder) => {
      const uid = folder.uidNext ?? Math.max(0, ...folder.messages.map((message) => message.uid)) + 1
      folder.uidNext = uid + 1
      return uid
    }
    const copyUid = (to: FakeFolder, from: number[], into: number[]) =>
      `COPYUID ${to.uidValidity ?? 777} ${from.join(",")} ${into.join(",")}`
    /** Where a message put in `name` lands: on Gmail, INBOX is a label of All Mail. */
    const landing = (name: string, message: FakeMessage): FakeFolder | undefined => {
      const folder = folderNamed(name)
      if (!options.gmail || !folder) return folder
      const all = special("\\All")
      if (folder.name.toUpperCase() === "INBOX" && all) {
        message.labels = [...new Set([...(message.labels ?? []), "\\Inbox"])]
        return all
      }
      return folder
    }
    const expunged = (folder: FakeFolder, gone: FakeMessage[]) => {
      const positions = gone.map((message) => folder.messages.indexOf(message) + 1).sort((a, b) => b - a)
      folder.messages = folder.messages.filter((message) => !gone.includes(message))
      for (const position of positions) send(`* ${position} EXPUNGE`)
    }
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
      if (command === "AUTHENTICATE") {
        const fields = Buffer.from(rest[1] ?? "", "base64")
          .toString("utf8")
          .split("\u0001")
        const user = fields[0]?.startsWith("user=") ? fields[0].slice(5) : /^n,a=([^,]*),/.exec(fields[0] ?? "")?.[1]
        const token = fields.find((field) => field.startsWith("auth=Bearer "))?.slice("auth=Bearer ".length) ?? ""
        tokensTried.push(token)
        const ok = user === options.login && (options.tokens ?? []).includes(token)
        return send(
          ok
            ? `${tag} OK [CAPABILITY ${capabilities.join(" ")}] authenticated`
            : `${tag} NO [AUTHENTICATIONFAILED] AUTHENTICATE failed.`,
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
          const counted = options.uncounted?.includes(folder.name) ? "" : `MESSAGES ${folder.messages.length} `
          send(`* STATUS ${quote(folder.name)} (${counted}UNSEEN ${unseen})`)
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
          send("* FLAGS (\\Seen \\Flagged \\Answered \\Draft \\Deleted)")
          send(
            `* OK [PERMANENTFLAGS (\\Seen \\Flagged \\Answered \\Draft \\Deleted${options.noKeywords ? "" : " \\*"})] ok`,
          )
          send(`* OK [UIDVALIDITY ${(folder.uidValidity ?? 777) + validityShift}] ok`)
          send(
            `* OK [UIDNEXT ${folder.uidNext ?? Math.max(0, ...folder.messages.map((message) => message.uid)) + 1}] ok`,
          )
          return send(`${tag} OK [${command === "SELECT" ? "READ-WRITE" : "READ-ONLY"}] done`)
        }
        case "UID": {
          const [sub = "", ...more] = rest
          if (sub.toUpperCase() === "SEARCH") {
            if (dropsLeft > 0) {
              dropsLeft -= 1
              return socket.destroy()
            }
            if (options.hangSearches) return
            if (options.refuseSearches) return send(`${tag} NO search failed`)
            const messages = selected?.messages ?? []
            const all = messages.map((message) => message.uid)
            const test = criteria(tokens(more.join(" ")))
            const found =
              options.search?.(more.join(" "), selected?.name ?? "") ??
              messages.filter((message) => test(message, all)).map((message) => message.uid)
            send(`* SEARCH ${found.join(" ")}`.trimEnd())
            return send(`${tag} OK done`)
          }
          if (sub.toUpperCase() === "FETCH") {
            const set = more[0] ?? ""
            const items = more.slice(1).join(" ")
            const wantsBody = /BODY(\.PEEK)?\[\]/i.test(items)
            if (refusalsLeft > 0) {
              refusalsLeft -= 1
              return send(`${tag} NO [UNAVAILABLE] backend error`)
            }
            if (/ENVELOPE/i.test(items) && options.brokenHeaders?.some((uid) => uidsOf(set).includes(uid)))
              return send(`${tag} NO [UNAVAILABLE] UID FETCH failure due to backend error`)
            if (wantsBody && options.brokenBodies?.some((uid) => uidsOf(set).includes(uid)))
              return send(`${tag} NO [UNAVAILABLE] UID FETCH failure due to backend error`)
            if (wantsBody && options.throttleBodies) return send(`${tag} NO [THROTTLED] Too many commands`)
            const messages = selected?.messages ?? []
            const reply = () => {
              let sent = 0
              for (const uid of uidsIn(
                set,
                messages.map((message) => message.uid),
              )) {
                const message = messages.find((one) => one.uid === uid)
                if (!message) continue
                if (unavailable.delete(uid)) {
                  send(
                    `* NO [UNAVAILABLE] UID FETCH message ${messages.indexOf(message) + 1} uid ${uid}: failure due to backend error`,
                  )
                  continue
                }
                if (fetchDropsLeft > 0 && sent === 0) {
                  fetchDropsLeft -= 1
                  if (options.validityAfterDrop !== undefined) validityShift = options.validityAfterDrop
                  return socket.destroy()
                }
                sent += 1
                const parts = [`UID ${uid}`]
                if (/FLAGS/i.test(items)) parts.push(`FLAGS (${(message.flags ?? []).join(" ")})`)
                if (/INTERNALDATE/i.test(items))
                  parts.push(`INTERNALDATE "${message.date ?? "28-Oct-2026 10:00:00 +0000"}"`)
                if (message.emailId && /EMAILID/i.test(items)) parts.push(`EMAILID (${message.emailId})`)
                if (message.threadId && /THREADID/i.test(items)) parts.push(`THREADID (${message.threadId})`)
                if (options.gmail && message.emailId && /X-GM-MSGID/i.test(items))
                  parts.push(`X-GM-MSGID ${message.emailId}`)
                if (options.gmail && message.threadId && /X-GM-THRID/i.test(items))
                  parts.push(`X-GM-THRID ${message.threadId}`)
                if (options.gmail && /X-GM-LABELS/i.test(items))
                  parts.push(`X-GM-LABELS (${(message.labels ?? []).map(atomOrQuoted).join(" ")})`)
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
            return options.hangFetches ? undefined : reply()
          }
          const verb = sub.toUpperCase()
          if (!selected) return send(`${tag} BAD no mailbox selected`)
          const folder = selected
          const words = tokens(more.join(" "))
          const picked = uidsIn(
            words[0] ?? "",
            folder.messages.map(({ uid }) => uid),
          )
            .map((uid) => folder.messages.find((message) => message.uid === uid))
            .filter((message): message is FakeMessage => message !== undefined)
          if (verb === "STORE") {
            const item = (words[1] ?? "").toUpperCase()
            const { values } = listOf(words, 2)
            const labels = item.includes("X-GM-LABELS")
            for (const message of picked) {
              const now = new Set(labels ? (message.labels ?? []) : (message.flags ?? []))
              if (item.startsWith("+")) for (const value of values) now.add(value)
              else if (item.startsWith("-")) for (const value of values) now.delete(value)
              else {
                now.clear()
                for (const value of values) now.add(value)
              }
              if (labels) message.labels = [...now]
              else message.flags = [...now]
              if (!item.includes(".SILENT"))
                send(
                  `* ${folder.messages.indexOf(message) + 1} FETCH (UID ${message.uid} ${labels ? `X-GM-LABELS (${[...now].map(atomOrQuoted).join(" ")})` : `FLAGS (${[...now].join(" ")})`})`,
                )
            }
            return send(`${tag} OK done`)
          }
          if (verb === "MOVE" || verb === "COPY") {
            const name = words[1] ?? ""
            const moved = picked.map((message) => ({
              message,
              copy: { ...message, flags: [...(message.flags ?? [])], labels: [...(message.labels ?? [])] },
            }))
            const into = moved.map(({ copy }) => landing(name, copy))
            if (into.some((target) => target === undefined)) return send(`${tag} NO [TRYCREATE] no such folder`)
            const target = into[0] as FakeFolder
            const from: number[] = []
            const to: number[] = []
            for (const { message, copy } of moved) {
              copy.uid = nextUid(target)
              target.messages.push(copy)
              from.push(message.uid)
              to.push(copy.uid)
            }
            if (verb === "COPY") return send(`${tag} OK [${copyUid(target, from, to)}] copied`)
            send(`* OK [${copyUid(target, from, to)}] moved`)
            expunged(
              folder,
              moved.map(({ message }) => message),
            )
            return send(`${tag} OK done`)
          }
          if (verb === "EXPUNGE") {
            expunged(
              folder,
              picked.filter((message) => message.flags?.includes("\\Deleted")),
            )
            return send(`${tag} OK done`)
          }
          return send(`${tag} BAD unknown UID command`)
        }
        case "EXPUNGE": {
          if (selected)
            expunged(
              selected,
              selected.messages.filter((message) => message.flags?.includes("\\Deleted")),
            )
          return send(`${tag} OK done`)
        }
        case "CREATE": {
          const [name = ""] = tokens(tail)
          if (folderNamed(name)) return send(`${tag} NO [ALREADYEXISTS] exists`)
          options.folders.push({ name, messages: [] })
          return send(`${tag} OK created`)
        }
        case "RENAME": {
          const [from = "", to = ""] = tokens(tail)
          const folder = folderNamed(from)
          if (!folder) return send(`${tag} NO [NONEXISTENT] no such folder`)
          folder.name = to
          return send(`${tag} OK renamed`)
        }
        case "DELETE": {
          const [name = ""] = tokens(tail)
          const folder = folderNamed(name)
          if (!folder) return send(`${tag} NO [NONEXISTENT] no such folder`)
          options.folders.splice(options.folders.indexOf(folder), 1)
          return send(`${tag} OK deleted`)
        }
        case "LOGOUT":
          send("* BYE bye")
          send(`${tag} OK done`)
          return socket.end()
        default:
          return send(`${tag} OK done`)
      }
    }

    // A non-ASCII search value comes as a literal: `{n}`, the go-ahead, then n bytes and the rest of the line.
    let pending = ""
    let literalBytes = 0
    /** APPEND's message comes as a literal after its line: `{n}`, a `+` from us, then n bytes. */
    const append = (tag: string, line: string, raw: string) => {
      commands.push(`APPEND ${line}`)
      const words = tokens(line)
      const folder = folderNamed(words[0] ?? "")
      if (!folder) return send(`${tag} NO [TRYCREATE] no such folder`)
      const { values } = words[1] === "(" ? listOf(words, 1) : { values: [] }
      const message: FakeMessage = { uid: nextUid(folder), raw, flags: values }
      folder.messages.push(message)
      return send(`${tag} OK [APPENDUID ${folder.uidValidity ?? 777} ${message.uid}] appended`)
    }
    let appending: { tag: string; line: string; size: number } | undefined

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        if (appending) {
          if (buffer.length < appending.size + 2) return
          const raw = buffer.subarray(0, appending.size).toString("utf8")
          buffer = buffer.subarray(buffer.indexOf("\r\n", appending.size) + 2)
          const { tag, line } = appending
          appending = undefined
          append(tag, line, raw)
          continue
        }
        if (literalBytes > 0) {
          if (buffer.length < literalBytes) return
          pending += JSON.stringify(buffer.subarray(0, literalBytes).toString("utf8"))
          buffer = buffer.subarray(literalBytes)
          literalBytes = 0
        }
        const end = buffer.indexOf("\r\n")
        if (end === -1) return
        const text = pending + buffer.subarray(0, end).toString("utf8")
        pending = ""
        buffer = buffer.subarray(end + 2)
        const [tag = "", verb = "", ...words] = text.split(" ")
        const size = /\{(\d+)(\+?)\}$/.exec(text)
        if (verb.toUpperCase() === "APPEND" && size) {
          appending = { tag, line: words.join(" ").replace(/\s*\{\d+\+?\}$/, ""), size: Number(size[1]) }
          if (!size[2]) send("+ go ahead")
          continue
        }
        // A search value outside ASCII comes as a literal too: `{n}`, the go-ahead, then n bytes and the rest of the line.
        if (size) {
          pending = text.slice(0, size.index)
          literalBytes = Number(size[1])
          if (!size[2]) send("+ go ahead")
          continue
        }
        if (tag) handle(tag, [verb, ...words].join(" "))
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
    tokensTried,
    connections: () => sockets.size,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  }
}
