import { type OAuthClientReport, oauthClientReport } from "@wirecat/cli-core/constants"
import { configuration } from "../config.js"
import { IDENTITY } from "../identity.js"
import { GOOGLE_GUIDE, googleClient, microsoftClient, sendScopeOf, signInRecords } from "../oauth.js"
import { providerFor } from "../providers.js"
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
/** A Google app left in Testing ends its sign-ins after 7 days; from day 6 doctor says so. */
const TESTING_WARN_DAYS = 6

export const oauthCheck = (env: NodeJS.ProcessEnv, now = Date.now()) => {
  const { configuredProfiles } = configuration.resolveSettings({}, { env, needsProfile: false })
  const records = signInRecords(env)
  const profiles = configuredProfiles.flatMap((profile) => {
    const { mailbox } = configuration.resolveSettings({ profile }, { env })
    const kind = mailbox.address ? providerFor(mailbox.address, mailbox.host)?.oauth : undefined
    if (mailbox.auth !== "oauth" || !kind) return []
    const record = records[profile]
    // The app the profile signed in with, which its refresh uses; else the one a new sign-in would take.
    let oauthClient: OAuthClientReport
    try {
      oauthClient = oauthClientReport(
        record?.source ? record : kind === "microsoft" ? microsoftClient(env, mailbox) : googleClient(env, mailbox),
      )
    } catch (error) {
      oauthClient = { client: null, source: null, reason: error instanceof Error ? error.message : String(error) }
    }
    const days = record ? Math.floor((now - Date.parse(record.signed_in_at)) / DAY_MS) : null
    return [
      {
        profile,
        provider: kind,
        oauth_client: oauthClient,
        signed_in_at: record?.signed_in_at ?? null,
        sends: record ? record.scopes.includes(sendScopeOf(kind)) : null,
        ...(kind === "google" ? { testing_expiry_risk: days !== null && days >= TESTING_WARN_DAYS } : {}),
      },
    ]
  })
  const sign = (profile: string) => `\`${IDENTITY.command} ${profile} session start\``
  return {
    fields: { oauth: profiles },
    notes: profiles.flatMap(({ profile, oauth_client, signed_in_at, sends, ...rest }) => [
      ...("testing_expiry_risk" in rest && rest.testing_expiry_risk
        ? [
            `profile ${profile} signed in to Google ${TESTING_WARN_DAYS}+ days ago: if your Google app is still in ` +
              `Testing, Google ends the sign-in on day 7. Publish the app (${GOOGLE_GUIDE}), then ${sign(profile)}`,
          ]
        : []),
      ...(oauth_client.client === null
        ? [`profile ${profile} has no OAuth app to sign in with again: ${oauth_client.reason}`]
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
