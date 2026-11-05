import { appendFile, mkdir, open, readdir, readFile, rm, truncate } from "node:fs/promises"
import { join } from "node:path"
import { CliError } from "@wirecat/cli-base"
import * as v from "valibot"
import type { ExportFormat } from "./format.js"

export const JOURNAL = ".mail-export.jsonl"

const HEADER = v.object({
  v: v.literal(1),
  format: v.picklist(["mbox", "maildir"]),
  account: v.string(),
}) satisfies v.GenericSchema<unknown, { format: ExportFormat }>

/** One finished batch: the messages now safely in the destination, and for mbox how long the folder's file is. */
const BATCH = v.object({
  folder: v.string(),
  validity: v.string(),
  uids: v.array(v.number()),
  size: v.optional(v.number()),
})

type Header = v.InferOutput<typeof HEADER>
type Batch = v.InferOutput<typeof BATCH>

const parsed = <T>(schema: v.GenericSchema<unknown, T>, line: string): T | undefined => {
  try {
    const result = v.safeParse(schema, JSON.parse(line))
    return result.success ? result.output : undefined
  } catch {
    return undefined
  }
}

export const doneKey = (folder: string, validity: string, uid: number): string => `${folder}\0${validity}\0${uid}`

const parse = (text: string): { header: Header; batches: Batch[] } | undefined => {
  const [first, ...rest] = text.split("\n").filter(Boolean)
  const header = first === undefined ? undefined : parsed(HEADER, first)
  if (header === undefined) return undefined
  const batches: Batch[] = []
  for (const line of rest) {
    const batch = parsed(BATCH, line)
    // A line cut short by a crash is a batch that never finished; its messages are written again.
    if (batch === undefined) break
    batches.push(batch)
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
      throw new CliError("validation_error", `${path} holds ${found.header.format} of ${found.header.account}`, {
        param: "resume",
        reason: "mail.export-other",
      })
  } else if (mode === "new" && entries && entries.length > 0) {
    throw new CliError("validation_error", found ? `${path} already holds an export` : `${path} is not empty`, {
      param: "output",
      reason: "mail.export-destination-exists",
      resumable: found !== undefined,
    })
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
