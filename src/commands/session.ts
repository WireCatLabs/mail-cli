import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import {
  baseContext,
  commandWords,
  FETCH,
  itemOf,
  LOCAL_READ,
  LOCAL_WRITE,
  logsInOrOut,
  outputFor,
  REMOTE_READ,
  refuseCommandName,
  refuseUnderReadOnly,
  renderAnswer,
  rootOf,
  secretInputOf,
} from "@wirecat/cli-core/cli"
import { Command } from "commander"
import { configuration } from "../config.js"
import { prepareFor } from "../discovery.js"
import { IDENTITY } from "../identity.js"
import { imapSource } from "../mail/imap.js"
import { prepareText } from "../providers.js"
import { contextOf, endpointOf, passwordsOf, refuseOffline } from "./context.js"
import { checkLogin } from "./login.js"

const answer = (command: Command, item: unknown) => renderAnswer(command, outputFor(command), itemOf(item))

const startCommand = () =>
  logsInOrOut(
    annotate(new Command("start"), {
      effects: FETCH,
      lifetime: "interactive",
      mcp: false,
      examples: [`${IDENTITY.command} ya session start`],
    }),
  )
    .summary("type the app password once and keep it in the keyring")
    .description("type the app password once, check it against the server, and keep it in the OS keyring")
    .action(async function (this: Command) {
      const context = contextOf(this)
      refuseCommandName(context.profile, commandWords(rootOf(this)), IDENTITY.command)
      refuseOffline(context.flags)
      refuseUnderReadOnly(this, "session start")
      const endpoint = endpointOf(context.settings)
      const { readSecret } = await import("@wirecat/cli-core")
      const address = context.settings.mailbox.address ?? endpoint.login
      const { provider, prepare } = prepareFor(address, endpoint.host)
      outputFor(this).renderer.note(prepareText(provider, prepare))
      const typed = await readSecret(`App password for ${endpoint.login} (hidden): `, secretInputOf(this))
      if (!typed) throw new CliError("validation_error", "no password was given; nothing was stored")
      const connect = context.environment.connect ?? imapSource
      const result = await baseContext(this, configuration.resolveSettings).run(() =>
        checkLogin(connect, endpoint, typed, address, prepare),
      )
      // Stored only after the server accepted it (WC-SECR-5).
      passwordsOf(context).write(typed)
      answer(this, {
        profile: context.profile,
        signed_in: true,
        login: endpoint.login,
        stored_in: "keyring",
        folders: result.folders,
      })
    })

const statusCommand = () =>
  annotate(new Command("status"), {
    effects: REMOTE_READ,
    examples: [`${IDENTITY.command} ya session status`, `${IDENTITY.command} ya session status --check --json`],
  })
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
      const connect = context.environment.connect ?? imapSource
      const source = connect(endpointOf(context.settings), stored.secret)
      try {
        await baseContext(this, configuration.resolveSettings).run(() => source.check())
      } finally {
        await source.close()
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
      const removed = passwordsOf(context).remove()
      answer(this, { profile: context.profile, ended: removed, mail: "retained" })
    })

export const sessionCommand = (): Command =>
  annotate(new Command("session"), { effects: LOCAL_READ })
    .description("keep this profile's app password in the OS keyring")
    .addCommand(startCommand())
    .addCommand(statusCommand())
    .addCommand(endCommand())
