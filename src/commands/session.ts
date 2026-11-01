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
import { PASSWORD_SOURCES, passwordStore } from "../secret.js"
import { contextOf, type MailEnvironment, openMail, passwordsOf, refuseOffline } from "./context.js"
import { sessionStartCommand } from "./session-start.js"

const answer = (command: Command, item: unknown) => renderAnswer(command, outputFor(command), itemOf(item))

const passwordFrom = v.nullable(v.picklist(PASSWORD_SOURCES))

const mailSessionStatus = v.strictObject({
  profile: v.string(),
  state: v.picklist(["saved", "missing"]),
  password_from: passwordFrom,
  address: v.nullable(v.string()),
  verified: v.boolean(),
})

const statusCommand = () =>
  answerEntity(
    annotate(new Command("status"), {
      effects: REMOTE_READ,
      examples: [`${IDENTITY.command} ya session status`, `${IDENTITY.command} ya session status --check --json`],
    }),
    "mail_session_status",
    mailSessionStatus,
  )
    .description("show where this profile's app password comes from; the password is never printed")
    .option("--check", "log in to the server to prove the password still works")
    .action(async function (this: Command, args: { check?: boolean }) {
      const context = contextOf(this)
      const stored = await passwordsOf(context).read()
      const status = {
        profile: context.profile,
        state: stored ? "saved" : "missing",
        password_from: stored?.source ?? null,
        address: context.settings.mailbox.address ?? null,
        verified: false,
      }
      if (!args.check || !stored) return answer(this, status)
      refuseOffline(context.flags)
      const { backend } = await openMail(context, { password: stored.secret })
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
    .description("forget this profile's app password on this computer; synced mail stays")
    .action(async function (this: Command) {
      const context = contextOf(this)
      refuseUnderReadOnly(this, "session end")
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
