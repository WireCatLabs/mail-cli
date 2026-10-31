import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import {
  answerEntity,
  baseContext,
  commandWords,
  environmentOf,
  FETCH,
  itemOf,
  LOCAL_READ,
  LOCAL_WRITE,
  listOf,
  logsInOrOut,
  outputFor,
  profileFree,
  profilesHere,
  REMOTE_READ,
  refuseCommandName,
  refuseUnderReadOnly,
  renderAnswer,
  rootOf,
  secretInputOf,
} from "@wirecat/cli-core/cli"
import { Command } from "commander"
import * as v from "valibot"
import { configuration } from "../config.js"
import { PROVIDER_NAMES, prepareFor } from "../discovery.js"
import { IDENTITY } from "../identity.js"
import { type ImapEndpoint, imapSource } from "../mail/imap.js"
import { profileOf, writeProfile } from "../profile.js"
import { PROVIDERS_URL, type Prepare, prepareText } from "../providers.js"
import { passwordStore } from "../secret.js"
import { collect, contextOf, endpointOf, type MailEnvironment, passwordsOf, refuseOffline } from "./context.js"
import { checkLogin } from "./login.js"
import { chosen, type MailboxFlags, type Pick, securityOf } from "./mailbox.js"

const answer = (command: Command, item: unknown) => renderAnswer(command, outputFor(command), itemOf(item))

const SERVER_FLAGS = ["address", "provider", "host", "port", "security", "login", "folder"] as const

/** Whether this run may prompt: a terminal, no `--json`, no `--no-input`, not CI. */
const mayAsk = (command: Command, environment: MailEnvironment, env: NodeJS.ProcessEnv): boolean =>
  (environment.tty ?? process.stdout.isTTY) === true &&
  command.optsWithGlobals<{ input?: boolean }>().input !== false &&
  outputFor(command).format === "pretty" &&
  !env.CI

const startCommand = () =>
  logsInOrOut(
    annotate(new Command("start"), {
      effects: FETCH,
      lifetime: "interactive",
      mcp: false,
      examples: [
        `${IDENTITY.command} ya session start --address me@example.com`,
        `${IDENTITY.command} ya session start`,
        `${IDENTITY.command} me session start --address me@example.com --host imap.example.com --security tls`,
      ],
    }),
  )
    .summary("sign in; a new profile is created first")
    .description(
      `sign this profile in. A new profile needs its mailbox: --address, or it is asked at a terminal; the server is found (built-in providers, the MX record, ISPDB, the domain's autoconfig; all providers: ${PROVIDERS_URL}); for a domain the built-in table does not know, the domain, never the address, goes to the DNS resolver, autoconfig.thunderbird.net and autoconfig.<domain>, and --provider or --host skips those lookups; the steps to prepare the mailbox are shown, the app password is asked (hidden) or read from ${IDENTITY.envPrefix}_PASSWORD, checked against the server, and only then the profile and the keyring entry are saved. An existing profile only asks for the password again. Without a terminal nothing is asked: a missing --address or password is a validation error`,
    )
    .option("--address <email>", "the full mail address of a new profile, also the login for most providers")
    .option("--provider <provider>", `skip discovery and use a built-in provider: ${PROVIDER_NAMES.join(", ")}`)
    .option("--host <host>", "skip discovery and use this IMAP host")
    .option("--port <port>", "IMAP port (default 993)")
    .option("--security <mode>", "tls or starttls (default tls)", securityOf)
    .option("--login <login>", "the login name, when it is not the full address")
    .option("--folder <folder>", "sync only this folder; repeat it for more", collect)
    .action(async function (this: Command, flags: MailboxFlags & { address?: string }) {
      const context = contextOf(this)
      const { environment, env } = context
      refuseCommandName(context.profile, commandWords(rootOf(this)), IDENTITY.command)
      refuseOffline(context.flags)
      refuseUnderReadOnly(this, "session start")
      const output = outputFor(this)
      const asking = mayAsk(this, environment, env)
      const ask = async (prompt: string, options: { echo?: boolean } = {}) => {
        const { readSecret } = await import("@wirecat/cli-core")
        return readSecret(prompt, { ...secretInputOf(this), ...options })
      }

      const known = context.settings.mailbox.address !== undefined
      let endpoint: ImapEndpoint
      let address: string
      let provider: string
      let prepare: Prepare
      let created: (() => string) | undefined
      if (known) {
        const same = flags.address?.trim().toLowerCase() === context.settings.mailbox.address?.toLowerCase()
        const given = SERVER_FLAGS.filter((flag) => flags[flag] !== undefined && !(flag === "address" && same))
        if (given.length)
          throw new CliError(
            "validation_error",
            `profile ${context.profile} already exists, so --${given[0]} cannot change it; edit it with \`${IDENTITY.command} ${context.profile} config set\` or use a new profile name`,
            { param: given[0] as string },
          )
        endpoint = endpointOf(context.settings)
        address = context.settings.mailbox.address ?? endpoint.login
        ;({ provider, prepare } = prepareFor(address, endpoint.host))
      } else {
        const typedAddress = flags.address ?? (asking ? (await ask("Mail address: ", { echo: true })).trim() : "")
        if (!typedAddress)
          throw new CliError(
            "validation_error",
            `profile ${context.profile} does not exist yet; name its mailbox with --address <email>`,
            { param: "address" },
          )
        address = typedAddress.toLowerCase()
        const pick: Pick | undefined = asking
          ? async () => {
              output.renderer.note(`No server found for ${address}. Built-in providers: ${PROVIDER_NAMES.join(", ")}`)
              return (
                (await ask("Which one hosts this mailbox? (empty to give up) ", { echo: true })).trim() || undefined
              )
            }
          : undefined
        const found = await chosen(address, flags, environment, pick)
        if (found.auth === "oauth")
          throw new CliError(
            "validation_error",
            `${found.provider} accepts only OAuth for IMAP, which this version cannot do yet`,
            { param: "address" },
          )
        endpoint = { ...found.imap, login: found.login }
        provider = found.provider
        prepare = found.prepare
        created = () => writeProfile(env, context.profile, profileOf(found, flags.folder), false).path
      }

      output.renderer.note(prepareText(provider, prepare))
      const passwordVariable = `${IDENTITY.envPrefix}_PASSWORD`
      const typed =
        env[passwordVariable]?.trim() ||
        (asking ? await ask(`App password for ${endpoint.login} (hidden): `) : undefined)
      if (!typed)
        throw new CliError(
          "validation_error",
          asking
            ? "no password was given; nothing was stored"
            : `there is no terminal to ask for the app password; set ${passwordVariable}`,
          { param: passwordVariable },
        )
      const connect = environment.connect ?? imapSource
      const result = await baseContext(this, configuration.resolveSettings).run(() =>
        checkLogin(connect, endpoint, typed, prepare),
      )
      // Stored only after the server accepted it (WC-SECR-5), the profile with it.
      const config = created?.()
      passwordsOf(context).write(typed)
      answer(this, {
        profile: context.profile,
        signed_in: true,
        login: endpoint.login,
        stored_in: "keyring",
        folders: result.folders,
        ...(config ? { created: true, config } : {}),
      })
    })

const passwordFrom = v.nullable(v.picklist(["environment", "keyring", "himalaya"]))

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
      const connect = context.environment.connect ?? imapSource
      const source = connect(endpointOf(context.settings), stored.secret)
      context.environment.trackCloseable?.(source)
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
    .addCommand(startCommand())
    .addCommand(statusCommand())
    .addCommand(endCommand())
    .addCommand(listCommand())
