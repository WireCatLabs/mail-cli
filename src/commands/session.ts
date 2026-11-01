import { annotate } from "@wirecat/cli-base/commands"
import {
  answerEntity,
  baseContext,
  environmentOf,
  itemOf,
  LOCAL_READ,
  LOCAL_WRITE,
  listOf,
  logsInOrOut,
  outputFor,
  profileFree,
  profilesHere,
  REMOTE_READ,
  refuseUnderReadOnly,
  renderAnswer,
} from "@wirecat/cli-core/cli"
import { Command } from "commander"
import * as v from "valibot"
import { configuration } from "../config.js"
import { IDENTITY } from "../identity.js"
import { oauthStorage, recordSignIn, signInRecords } from "../oauth.js"
import { PASSWORD_SOURCES, passwordStore } from "../secret.js"
import {
  contextOf,
  type MailEnvironment,
  oauthKeeperOf,
  oauthKindOf,
  openMail,
  passwordsOf,
  refuseOffline,
} from "./context.js"
import { sessionStartCommand } from "./session-start.js"

const answer = (command: Command, item: unknown) => renderAnswer(command, outputFor(command), itemOf(item))

const passwordFrom = v.nullable(v.picklist(PASSWORD_SOURCES))

const AUTH = v.picklist(["app-password", "oauth"])

const mailSessionStatus = v.strictObject({
  profile: v.string(),
  state: v.picklist(["saved", "missing"]),
  auth: AUTH,
  password_from: passwordFrom,
  address: v.nullable(v.string()),
  verified: v.boolean(),
  oauth: v.optional(
    v.strictObject({
      provider: v.string(),
      client: v.nullable(v.picklist(["wirecat", "own"])),
      scopes: v.array(v.string()),
      access_expires_at: v.nullable(v.string()),
      signed_in_at: v.nullable(v.string()),
    }),
  ),
})

/** What a profile's OAuth sign-in holds, read from the keyring; never a token. */
const oauthStatus = (context: ReturnType<typeof contextOf>) => {
  const kind = oauthKindOf(context.settings.mailbox)
  if (!kind) return undefined
  const saved = oauthStorage({
    env: context.env,
    profile: context.profile,
    kind,
    keyring: context.environment.keyring,
  }).read()
  const record = signInRecords(context.env)[context.profile]
  return {
    saved: saved !== undefined,
    oauth: {
      provider: kind,
      client: record?.client ?? null,
      scopes: saved?.tokens.scopes ?? [],
      access_expires_at: saved?.tokens.expiresAt === undefined ? null : new Date(saved.tokens.expiresAt).toISOString(),
      signed_in_at: record?.signed_in_at ?? null,
    },
  }
}

const statusCommand = () =>
  answerEntity(
    annotate(new Command("status"), {
      effects: REMOTE_READ,
      examples: [`${IDENTITY.command} ya session status`, `${IDENTITY.command} ya session status --check --json`],
    }),
    "mail_session_status",
    mailSessionStatus,
  )
    .description(
      "show where this profile's app password comes from, or what its OAuth sign-in allows and until when; no " +
        "password or token is ever printed",
    )
    .option("--check", "log in to the server to prove the password or sign-in still works")
    .action(async function (this: Command, args: { check?: boolean }) {
      const context = contextOf(this)
      const { auth } = context.settings.mailbox
      const signedIn = auth === "oauth" ? oauthStatus(context) : undefined
      const stored = auth === "oauth" ? undefined : await passwordsOf(context).read()
      const status = {
        profile: context.profile,
        state: (signedIn?.saved ?? stored) ? "saved" : "missing",
        auth,
        password_from: stored?.source ?? null,
        address: context.settings.mailbox.address ?? null,
        verified: false,
        ...(signedIn ? { oauth: signedIn.oauth } : {}),
      }
      if (!args.check || status.state === "missing") return answer(this, status)
      refuseOffline(context.flags)
      const { backend } = await openMail(context)
      try {
        await baseContext(this, configuration.resolveSettings).run(() => backend.check())
      } finally {
        await backend.close()
      }
      answer(this, { ...status, verified: true })
    })

const endCommand = () =>
  logsInOrOut(
    annotate(new Command("end"), {
      effects: LOCAL_WRITE,
      mcp: false,
      examples: [`${IDENTITY.command} ya session end`],
    }),
  )
    .description("forget this profile's app password or OAuth sign-in on this computer; synced mail stays")
    .option(
      "--revoke",
      "Gmail over OAuth: also ask Google to revoke the sign-in, which ends every sign-in of that Google project",
    )
    .action(async function (this: Command, args: { revoke?: boolean }) {
      const context = contextOf(this)
      refuseUnderReadOnly(this, "session end")
      const kind = context.settings.mailbox.auth === "oauth" ? oauthKindOf(context.settings.mailbox) : undefined
      if (kind) {
        const revoke = args.revoke === true && kind === "google"
        if (revoke) refuseOffline(context.flags)
        const { revoked, removed } = await oauthKeeperOf(context, kind).signOut({ revoke })
        await recordSignIn(context.env, context.profile, undefined)
        answer(this, { profile: context.profile, ended: removed.length > 0, revoked, mail: "retained" })
        const note = (text: string) => outputFor(this).renderer.note(text)
        // https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens: no revoke a public client can call.
        if (kind === "microsoft")
          note(
            "Microsoft still lists mail's access until you remove it: https://account.live.com/consent/Manage for a " +
              "personal account, https://myapps.microsoft.com for a work or school account",
          )
        // https://developers.google.com/identity/protocols/oauth2/native-app: a revoke ends the whole project's grants.
        else if (revoked)
          note("Google revoked every sign-in of this Google project, including other tools that use the same project")
        else note("Google still lists the app until you remove it at https://myaccount.google.com/connections")
        return
      }
      const passwords = passwordsOf(context)
      if (passwords.usesOwnersSignIn()) {
        answer(this, { profile: context.profile, ended: false, mail: "retained", kept: "owners-sign-in" })
        outputFor(this).renderer.note(
          `kept the app password of ${context.profile}: this run's folders are moved, and it uses the owner's password, ` +
            "which only a run with the owner's own folders can remove",
        )
        return
      }
      answer(this, { profile: context.profile, ended: passwords.remove(), mail: "retained" })
    })

const mailProfile = v.strictObject({
  profile: v.string(),
  address: v.nullable(v.string()),
  auth: AUTH,
  password_from: passwordFrom,
})

const listCommand = () =>
  profileFree(
    answerEntity(
      annotate(new Command("list"), {
        effects: LOCAL_READ,
        examples: [`${IDENTITY.command} session list`, `${IDENTITY.command} session list --json`],
      }),
      "mail_profile",
      mailProfile,
    ),
  )
    .summary("list the profiles here and whether each has an app password")
    .description(
      "list the profiles on this computer, each with its address and where its app password comes from; picks none and asks no server",
    )
    .action(async function (this: Command) {
      const environment = environmentOf<MailEnvironment>(this)
      const env = environment.env ?? process.env
      const { configuredProfiles } = configuration.resolveSettings({}, { env, needsProfile: false })
      const items = []
      for (const profile of profilesHere(IDENTITY, configuredProfiles, env)) {
        const settings = configuration.resolveSettings({ profile }, { env })
        const stored = await passwordStore({
          env,
          profile,
          keyring: environment.keyring,
          himalaya: environment.himalaya,
        }).read()
        items.push({
          profile,
          address: settings.mailbox.address ?? null,
          auth: settings.mailbox.auth,
          password_from: stored?.source ?? null,
        })
      }
      renderAnswer(
        this,
        outputFor(this),
        listOf("session list", { items, limit: Math.max(1, items.length), has_more: false }),
      )
    })

export const sessionCommand = (): Command =>
  annotate(new Command("session"), { effects: LOCAL_READ })
    .description("keep this profile's app password in the OS keyring")
    .addCommand(sessionStartCommand())
    .addCommand(statusCommand())
    .addCommand(endCommand())
    .addCommand(listCommand())
