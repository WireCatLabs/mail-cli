import { CliError } from "@wirecat/cli-base"
import type { FetchMessageObject, ImapFlow, SearchObject } from "imapflow"
import type { MailWrites, Moved, ServerState } from "../backend.js"
import type { Connections } from "./connection.js"

const SEARCH_IDS = 100

const range = (uids: readonly number[]) => uids.join(",")

const movedOf = (answer: Awaited<ReturnType<ImapFlow["messageMove"]>>): Moved =>
  answer === false
    ? { uids: new Map() }
    : {
        uids: new Map(answer.uidMap ?? []),
        ...(answer.uidValidity === undefined ? {} : { validity: String(answer.uidValidity) }),
      }

/** Every change the mail commands make, over imapflow. Each is one command per folder, never repeated. */
export const imapWrites = (pool: Connections): MailWrites => {
  const changed = async (done: Promise<boolean>, what: string) => {
    if (!(await done)) throw new CliError("provider_unavailable", `the server refused to ${what}`)
  }

  return {
    locate: (folder, { emailIds = [], messageIds = [] }) =>
      pool.inFolder(folder, async (open, validity) => {
        const uids = new Map<string, number>()
        const found = async (queries: SearchObject[], keyOf: (message: FetchMessageObject) => string | undefined) => {
          for (let at = 0; at < queries.length; at += SEARCH_IDS) {
            const part = queries.slice(at, at + SEARCH_IDS)
            const hits =
              (await open.search(part.length === 1 ? (part[0] as SearchObject) : { or: part }, { uid: true })) || []
            if (hits.length === 0) continue
            for (const message of await open.fetchAll(
              hits,
              { uid: true, emailId: true, envelope: true },
              { uid: true },
            )) {
              const key = keyOf(message)
              if (key !== undefined) uids.set(key, message.uid)
            }
          }
        }
        const wantedEmails = new Set(emailIds)
        await found(
          emailIds.map((emailId) => ({ emailId })),
          (message) =>
            message.emailId && wantedEmails.has(String(message.emailId)) ? String(message.emailId) : undefined,
        )
        const wantedMessages = new Set(messageIds)
        await found(
          messageIds.map((messageId) => ({ header: { "message-id": messageId } })),
          (message) => {
            const id = message.envelope?.messageId
            return id && wantedMessages.has(id) ? id : undefined
          },
        )
        return { validity, uids }
      }),

    state: (folder, validity, uids) =>
      pool.inFolder(
        folder,
        async (open) => {
          const states = new Map<number, ServerState>()
          if (uids.length === 0) return states
          const fetched = await open.fetchAll(
            range(uids),
            { uid: true, flags: true, labels: true, envelope: true },
            { uid: true },
          )
          for (const message of fetched)
            states.set(message.uid, {
              flags: [...(message.flags ?? [])].sort(),
              ...(message.labels ? { labels: [...message.labels].sort() } : {}),
              ...(message.envelope?.messageId ? { messageId: message.envelope.messageId } : {}),
            })
          return states
        },
        validity,
      ),

    flag: (folder, validity, uids, { add = [], remove = [] }) =>
      pool.writeIn(
        folder,
        async (open) => {
          if (add.length) await changed(open.messageFlagsAdd(range(uids), add, { uid: true }), "add the flags")
          if (remove.length)
            await changed(open.messageFlagsRemove(range(uids), remove, { uid: true }), "remove the flags")
        },
        validity,
      ),

    label: (folder, validity, uids, { add = [], remove = [] }) =>
      pool.writeIn(
        folder,
        async (open) => {
          if (add.length)
            await changed(open.messageFlagsAdd(range(uids), add, { uid: true, useLabels: true }), "add the labels")
          if (remove.length)
            await changed(
              open.messageFlagsRemove(range(uids), remove, { uid: true, useLabels: true }),
              "remove the labels",
            )
        },
        validity,
      ),

    move: (folder, validity, uids, to) =>
      pool.writeIn(folder, async (open) => movedOf(await open.messageMove(range(uids), to, { uid: true })), validity),

    copy: (folder, validity, uids, to) =>
      pool.writeIn(folder, async (open) => movedOf(await open.messageCopy(range(uids), to, { uid: true })), validity),

    expunge: (folder, validity, uids) =>
      pool.writeIn(
        folder,
        async (open) => {
          if (!open.capabilities.has("UIDPLUS"))
            throw new CliError(
              "provider_unavailable",
              "the server cannot expunge single messages (no UIDPLUS), so a copy cannot be taken back alone",
              { reason: "mail.no-uidplus" },
            )
          await changed(open.messageDelete(range(uids), { uid: true }), "remove the copies")
        },
        validity,
      ),

    append: (folder, raw, flags) =>
      pool.writeOnServer(async (open) => {
        const done = await open.append(folder, Buffer.from(raw), [...flags])
        if (!done) throw new CliError("provider_unavailable", `the server refused to store the message in ${folder}`)
        return {
          ...(done.uid === undefined ? {} : { uid: done.uid }),
          ...(done.uidValidity === undefined ? {} : { validity: String(done.uidValidity) }),
        }
      }),

    createFolder: (path) =>
      pool.writeOnServer(async (open) => {
        await open.mailboxCreate(path)
      }),

    renameFolder: (path, to) =>
      pool.writeOnServer(async (open) => {
        await open.mailboxRename(path, to)
      }),

    deleteFolder: (path) =>
      pool.writeOnServer(async (open) => {
        await open.mailboxDelete(path)
      }),
  }
}
