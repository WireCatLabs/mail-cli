import { appendFile, mkdir, open, readdir, readFile, rm, truncate } from "node:fs/promises"
import { join } from "node:path"
import { CliError } from "@wirecat/cli-base"
import type { ExportFormat } from "./format.js"

export const JOURNAL = ".mail-export.jsonl"

interface Header {
  v: 1
  format: ExportFormat
  account: string
}

/** One finished batch: the messages now safely in the destination, and for mbox how long the folder's file is. */
interface Batch {
  folder: string
  validity: string
  uids: number[]
  size?: number
}

export const doneKey = (folder: string, validity: string, uid: number): string => `${folder}\0${validity}\0${uid}`

const parse = (text: string): { header: Header; batches: Batch[] } | undefined => {
  const lines = text.split("\n").filter(Boolean)
  if (lines.length === 0) return undefined
  const header = JSON.parse(lines[0] as string) as Header
  const batches: Batch[] = []
  for (const line of lines.slice(1)) {
    try {
      batches.push(JSON.parse(line) as Batch)
    } catch {
      // A line cut short by a crash is a batch that never finished; its messages are written again.
      break
    }
  }
  return { header, batches }
}

export interface ExportJournal {
  done: Set<string>
  /** mbox: the length each folder's file had after its last finished batch. */
  sizes: Map<string, number>
  record(batch: Batch): Promise<void>
}

export interface Destination {
  path: string
  format: ExportFormat
  account: string
  /** `resume` goes on in a folder that holds an export; `replace` writes into any folder, over what has the same name. */
  mode: "new" | "resume" | "replace"
}

const exists = async (path: string): Promise<string[] | undefined> =>
  readdir(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })

/**
 * Decides whether the folder may be written into before anything is fetched. A folder with an export in it needs
 * `--resume`; any other folder with something in it needs `--replace`.
 */
export const openJournal = async ({ path, format, account, mode }: Destination): Promise<ExportJournal> => {
  const entries = await exists(path)
  const journalPath = join(path, JOURNAL)
  const text = entries?.includes(JOURNAL) ? await readFile(journalPath, "utf8") : undefined
  const found = text === undefined ? undefined : parse(text)
  if (mode === "resume") {
    if (!found) throw new CliError("not_found", `${path} holds no export to resume`, { param: "resume" })
    if (found.header.format !== format || found.header.account !== account)
      throw new CliError(
        "validation_error",
        `${path} holds ${found.header.format} of ${found.header.account}; resume it with the same --format and profile`,
        { param: "resume" },
      )
  } else if (mode === "new" && entries && entries.length > 0) {
    throw new CliError(
      "validation_error",
      found
        ? `${path} already holds an export; --resume goes on with it, --replace starts over in it`
        : `${path} is not empty; --replace writes into it anyway, over files of the same name`,
      { param: "output", reason: "mail.export-destination-exists" },
    )
  }
  await mkdir(path, { recursive: true, mode: 0o700 })
  const start = mode === "resume" && found ? found : undefined
  if (!start) {
    const head: Header = { v: 1, format, account }
    await rm(journalPath, { force: true })
    await appendFile(journalPath, `${JSON.stringify(head)}\n`, { mode: 0o600 })
  }
  const done = new Set<string>()
  const sizes = new Map<string, number>()
  for (const batch of start?.batches ?? []) {
    for (const uid of batch.uids) done.add(doneKey(batch.folder, batch.validity, uid))
    if (batch.size !== undefined) sizes.set(batch.folder, batch.size)
  }
  return {
    done,
    sizes,
    record: async (batch) => {
      const handle = await open(journalPath, "a", 0o600)
      try {
        await handle.appendFile(`${JSON.stringify(batch)}\n`)
        await handle.sync()
      } finally {
        await handle.close()
      }
      for (const uid of batch.uids) done.add(doneKey(batch.folder, batch.validity, uid))
      if (batch.size !== undefined) sizes.set(batch.folder, batch.size)
    },
  }
}

/** A crash can leave bytes after the last finished batch; cutting back to it keeps every message whole. */
export const cutTo = (file: string, size: number): Promise<void> => truncate(file, size)
