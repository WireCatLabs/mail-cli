import type { AccountCheck, FolderInfo, MailBackend } from "../backend.js"
import type { Connections } from "./connection.js"
import { roleOf } from "./messages.js"

/** What a command asks of the account itself: its folders and what the server supports. */
export const imapAccount = (
  pool: Connections,
  login: string,
): Pick<MailBackend, "check" | "folderList"> & Required<Pick<MailBackend, "folders">> => {
  const folderList = (): Promise<FolderInfo[]> =>
    pool.onServer(async (open) =>
      (await open.list({ statusQuery: { messages: true, unseen: true } }))
        .filter((entry) => !entry.flags.has("\\Noselect") && !entry.flags.has("\\NonExistent"))
        .map((entry) => ({
          path: entry.path,
          name: entry.name,
          role: roleOf(entry),
          messages: entry.status?.messages ?? null,
          unseen: entry.status?.unseen ?? null,
        })),
    )

  return {
    folderList,

    folders: async () => {
      const entries = await folderList()
      const role = (...names: string[]) => entries.find((entry) => entry.role && names.includes(entry.role))?.path
      return { all: role("all", "archive") ?? "INBOX", trash: role("trash") ?? "Trash" }
    },

    check: () =>
      pool.onServer(async (open): Promise<AccountCheck> => {
        const has = (name: string) => open.capabilities.has(name)
        const folders = (await open.list()).length
        return {
          login,
          capabilities: [...open.capabilities.keys()].sort(),
          features: {
            idle: has("IDLE"),
            condstore: has("CONDSTORE"),
            qresync: has("QRESYNC"),
            move: has("MOVE"),
            uidplus: has("UIDPLUS"),
            compress: has("COMPRESS=DEFLATE"),
            x_gm_ext_1: has("X-GM-EXT-1"),
            objectid: has("OBJECTID"),
          },
          folders,
        }
      }),
  }
}
