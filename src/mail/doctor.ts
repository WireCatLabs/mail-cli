import { IDENTITY } from "../identity.js"
import { runSummaries } from "./changes.js"

const DAY_MS = 86_400_000
/** As memo's doctor warned: early enough to look at what a cleanup trashed before Gmail empties its Trash. */
const WARN_DAYS = 5

/**
 * What `doctor` reads of the change runs on disk, with no connection: a run that stopped part way, and Gmail Trash
 * a run filled that Gmail empties within days. memo's doctor said this until the cleanup moved here (NEED-2111).
 */
export const changesCheck = (env: NodeJS.ProcessEnv, now = Date.now()) => {
  const runs = runSummaries(env)
  const restore = (id: string, account: string) =>
    `\`${IDENTITY.command} <profile of ${account}> messages restore --run ${id} --yes\``
  const unfinished = runs.filter(({ unfinished }) => unfinished)
  const expiring = runs.filter(({ restorable_until, in_trash }) => {
    const left = restorable_until === null ? 0 : Date.parse(restorable_until) - now
    return in_trash > 0 && left > 0 && left < WARN_DAYS * DAY_MS
  })
  return {
    fields: {
      changes: {
        runs: runs.length,
        unfinished: unfinished.map(({ id, account, command, started_at }) => ({ id, account, command, started_at })),
        expiring: expiring.map(({ id, account, restorable_until, in_trash }) => ({
          id,
          account,
          restorable_until,
          in_trash,
        })),
      },
    },
    notes: [
      ...unfinished.map(
        ({ id, account, command }) =>
          `run ${id} of ${account} (${command}) stopped before the end; ${restore(id, account)} undoes what it did, ` +
          "or run the command again to finish it",
      ),
      ...expiring.map(
        ({ id, account, restorable_until, in_trash }) =>
          `run ${id} of ${account} left ${in_trash} emails in Gmail's Trash, which Gmail empties at ${restorable_until}; ` +
          `${restore(id, account)} brings them back before then`,
      ),
    ],
  }
}
