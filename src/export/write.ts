import { chmod, mkdir, open, rename, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { type ExportFormat, maildirDir, maildirName, mboxEntry, mboxFile } from "./format.js"
import { cutTo, type ExportJournal } from "./journal.js"

export interface Written {
  folder: string
  validity: string
  uid: number
  receivedAt: number | null
  read: boolean | null
  flagged: boolean | null
  raw: Uint8Array
}

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  )

const writeMbox = async (root: string, journal: ExportJournal, folder: string, validity: string, batch: Written[]) => {
  const file = join(root, mboxFile(folder))
  const size = journal.sizes.get(folder)
  if (size !== undefined) await cutTo(file, size)
  const handle = await open(file, size === undefined ? "w" : "a", 0o600)
  try {
    await handle.appendFile(Buffer.concat(batch.map((one) => mboxEntry(one.raw, one.receivedAt))))
    await handle.sync()
  } finally {
    await handle.close()
  }
  await chmod(file, 0o600)
  await journal.record({ folder, validity, uids: batch.map((one) => one.uid), size: (await stat(file)).size })
}

const writeMaildir = async (
  root: string,
  journal: ExportJournal,
  folder: string,
  validity: string,
  batch: Written[],
  replace: boolean,
) => {
  const base = join(root, maildirDir(folder))
  for (const part of ["", "cur", "new", "tmp"]) await mkdir(join(base, part), { recursive: true, mode: 0o700 })
  for (const one of batch) {
    const name = maildirName(one.receivedAt, validity, one.uid, one.read, one.flagged)
    const target = join(base, "cur", name)
    // The name holds the folder's UIDVALIDITY and the UID, so a file already there is this message.
    if (!replace && (await exists(target))) continue
    const scratch = join(base, "tmp", name)
    await writeFile(scratch, one.raw, { mode: 0o600 })
    await rename(scratch, target)
  }
  await journal.record({ folder, validity, uids: batch.map((one) => one.uid) })
}

/** Writes one folder's finished messages and only then notes them in the journal, so a crash repeats at most a batch. */
export const writeBatch = (
  format: ExportFormat,
  root: string,
  journal: ExportJournal,
  folder: string,
  validity: string,
  batch: Written[],
  replace: boolean,
): Promise<void> =>
  format === "mbox"
    ? writeMbox(root, journal, folder, validity, batch)
    : writeMaildir(root, journal, folder, validity, batch, replace)
