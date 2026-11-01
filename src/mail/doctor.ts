import { configuration } from "../config.js"
import { IDENTITY } from "../identity.js"
import { MICROSOFT_SMTP_SCOPE, microsoftClient, OAUTH_GUIDE, signInRecords } from "../oauth.js"
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

/**
 * Each OAuth profile from disk alone: the app it signs in with and what its last sign-in allowed. The tokens are in
 * the keyring, which doctor never opens; `session status --check` proves one still works.
 */
export const oauthCheck = (env: NodeJS.ProcessEnv) => {
  const { configuredProfiles } = configuration.resolveSettings({}, { env, needsProfile: false })
  const records = signInRecords(env)
  const profiles = configuredProfiles.flatMap((profile) => {
    const { mailbox } = configuration.resolveSettings({ profile }, { env })
    if (mailbox.auth !== "oauth") return []
    let client: "wirecat" | "own" | null
    try {
      client = microsoftClient(mailbox).source
    } catch {
      client = null
    }
    const record = records[profile]
    return [
      {
        profile,
        client,
        signed_in_at: record?.signed_in_at ?? null,
        sends: record ? record.scopes.includes(MICROSOFT_SMTP_SCOPE) : null,
      },
    ]
  })
  const sign = (profile: string) => `\`${IDENTITY.command} ${profile} session start\``
  return {
    fields: { oauth: profiles },
    notes: profiles.flatMap(({ profile, client, signed_in_at, sends }) => [
      ...(client === null
        ? [
            `profile ${profile} has no Microsoft app to sign in with again: set one with ` +
              `\`${IDENTITY.command} config set --defaults microsoft_client_id <id>\` (${OAUTH_GUIDE})`,
          ]
        : []),
      ...(signed_in_at === null
        ? [`profile ${profile} has no OAuth sign-in on record here; run ${sign(profile)}`]
        : []),
      ...(sends === false
        ? [`profile ${profile} was not allowed to send at its last sign-in; ${sign(profile)} asks again`]
        : []),
    ]),
  }
}

/** Every check doctor reads from disk, as one `local` hook. */
export const localChecks = (env: NodeJS.ProcessEnv) => {
  const changes = changesCheck(env)
  let oauth: ReturnType<typeof oauthCheck>
  try {
    oauth = oauthCheck(env)
  } catch {
    // A config file doctor cannot read is reported as `config.issues` already.
    oauth = { fields: { oauth: [] }, notes: [] }
  }
  return { fields: { ...changes.fields, ...oauth.fields }, notes: [...changes.notes, ...oauth.notes] }
}
