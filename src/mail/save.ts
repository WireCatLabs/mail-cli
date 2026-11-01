import { randomUUID } from "node:crypto"
import { closeSync, linkSync, lstatSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, extname, join } from "node:path"
import { CliError } from "@wirecat/cli-base"

const exists = (path: string) =>
  new CliError("validation_error", `${path} already exists; pass --replace to overwrite it`, {
    reason: "download.exists",
    param: "output-dir",
  })

export const present = (path: string): boolean => {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

/**
 * A file only this user reads. Without `overwrite` an existing file is never touched: the bytes go to a new temporary
 * file that is then hard-linked in place, which fails if something appeared there meanwhile.
 */
export const savePrivately = (path: string, bytes: Uint8Array, overwrite: boolean): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temp = join(dirname(path), `.${randomUUID()}.tmp`)
  let created = false
  try {
    const fd = openSync(temp, "wx", 0o600)
    created = true
    try {
      writeFileSync(fd, bytes)
    } finally {
      closeSync(fd)
    }
    if (overwrite) renameSync(temp, path)
    else linkSync(temp, path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw exists(path)
    throw error
  } finally {
    if (created) rmSync(temp, { force: true })
  }
}

export const refuseExisting = (path: string): void => {
  if (present(path)) throw exists(path)
}

/** A sender's file name as a plain name in the folder: no path, no hidden file, nothing a file system refuses. */
export const safeName = (name: string, fallback: string): string => {
  const plain = basename(name.replace(/\\/g, "/"))
    .replace(/[<>:"|?*]/g, "_")
    .replace(/\p{Cc}/gu, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 200)
  return plain || fallback
}

/** `report.pdf`, then `report (2).pdf` for the second of the same name in one message. */
export const distinctNames = (names: readonly string[]): string[] => {
  const used = new Map<string, number>()
  return names.map((name) => {
    const seen = (used.get(name.toLowerCase()) ?? 0) + 1
    used.set(name.toLowerCase(), seen)
    if (seen === 1) return name
    const extension = extname(name)
    return `${name.slice(0, name.length - extension.length)} (${seen})${extension}`
  })
}
