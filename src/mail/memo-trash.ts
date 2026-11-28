import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { resolvePaths } from "@wirecat/cli-base"

const folderOf = (appName: string, prefix: string, env: NodeJS.ProcessEnv) =>
  join(resolvePaths({ appName, prefix, env }).state, "mail-trash")

let warned = false

/**
 * The cleanup runs memo wrote before the cleanup moved here. memo is now wcat, whose first start moves its state
 * folder from `cli-memo` to `wcat`. mail-cli may run first, so it moves `mail-trash` itself: the old path is read only
 * to move it. Both present means a person or a half-done move made them: merging could lose a run, so nothing moves.
 */
export const memoTrashFolder = (env: NodeJS.ProcessEnv, warn: (line: string) => void = defaultWarn): string => {
  const current = folderOf("wcat", "WCAT", env)
  const old = folderOf("cli-memo", "MEMO", env)
  if (!existsSync(old)) return current
  if (existsSync(current)) {
    if (!warned) warn(`mail-trash is in both ${old} and ${current}; reading ${current} only`)
    warned = true
    return current
  }
  try {
    mkdirSync(dirname(current), { recursive: true })
    try {
      renameSync(old, current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error
      cpSync(old, current, { recursive: true, errorOnExist: true, force: false })
      rmSync(old, { recursive: true })
    }
  } catch (error) {
    if (!warned) warn(`could not move ${old} to ${current}: ${(error as Error).message}`)
    warned = true
    return existsSync(current) ? current : old
  }
  return current
}

const defaultWarn = (line: string) => process.stderr.write(`mail: ${line}\n`)

/** For tests: the warning shows once per process. */
export const resetMemoTrashWarning = () => {
  warned = false
}
