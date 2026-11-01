import { lstatSync, mkdirSync } from "node:fs"
import { dirname, extname } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { safeName as plainName, writeFileAtomic } from "@wirecat/cli-core/files"

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

/** A file only this user reads. Without `overwrite` an existing file is never touched. */
export const savePrivately = async (path: string, bytes: Uint8Array, overwrite: boolean): Promise<void> => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  try {
    await writeFileAtomic(path, bytes, { overwrite })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw exists(path)
    throw error
  }
}

export const refuseExisting = (path: string): void => {
  if (present(path)) throw exists(path)
}

/** A sender's file name as cli-core's downloads clean it, or `fallback` when nothing safe is left of it. */
export const safeName = (name: string, fallback: string): string => plainName(name)?.slice(0, 200) || fallback

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
