import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import {
  baseContext,
  commandWords,
  FETCH,
  itemOf,
  logsInOrOut,
  outputFor,
  refuseCommandName,
  refuseUnderReadOnly,
  renderAnswer,
  rootOf,
  secretInputOf,
} from "@wirecat/cli-core/cli"
import { Command } from "commander"
import { configuration } from "../config.js"
import { PROVIDER_NAMES } from "../discovery.js"
import { IDENTITY } from "../identity.js"
import type { MailEndpoint } from "../mail/backend.js"
import { profileOf, writeProfile } from "../profile.js"
import { GENERIC_PREPARE, PROVIDERS_URL, type Prepare, prepareText, providerFor } from "../providers.js"
import {
  collect,
  contextOf,
  endpointOf,
  type MailEnvironment,
  openMail,
  passwordsOf,
  refuseOffline,
} from "./context.js"
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

export const sessionStartCommand = () =>
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
    .option(
      "--credential-storage <storage>",
      "where the password is kept: keyring (the default, which falls back to a private file by itself when no " +
        "keyring works), or file, not recommended",
      "keyring",
    )
    .action(async function (this: Command, flags: MailboxFlags & { address?: string; credentialStorage: string }) {
      const context = contextOf(this)
      const { environment, env } = context
      refuseCommandName(context.profile, commandWords(rootOf(this)), IDENTITY.command)
      const storage = flags.credentialStorage
      if (storage !== "keyring" && storage !== "file")
        throw new CliError("validation_error", "--credential-storage takes keyring or file", {
          param: "credential-storage",
        })
      refuseOffline(context.flags)
      refuseUnderReadOnly(this, "session start")
      const output = outputFor(this)
      const asking = mayAsk(this, environment, env)
      const ask = async (prompt: string, options: { echo?: boolean } = {}) => {
        const { readSecret } = await import("@wirecat/cli-core")
        return readSecret(prompt, { ...secretInputOf(this), ...options })
      }

      const known = context.settings.mailbox.address !== undefined
      let endpoint: MailEndpoint
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
        const hosting = providerFor(address, endpoint.host)
        provider = hosting?.name ?? address.split("@")[1] ?? "this"
        prepare = hosting?.prepare ?? GENERIC_PREPARE
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

      output.renderer.note(`Server: ${endpoint.host}:${endpoint.port} (${endpoint.security}), login ${endpoint.login}`)
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
      const { backend } = await openMail(context, { endpoint, password: typed })
      const result = await baseContext(this, configuration.resolveSettings).run(() => checkLogin(backend, prepare))
      // Stored only after the server accepted it (WC-SECR-5), the profile with it.
      const config = created?.()
      const stored = passwordsOf(context).write(typed, storage)
      answer(this, {
        profile: context.profile,
        signed_in: true,
        login: endpoint.login,
        credential_storage: stored,
        folders: result.folders,
        ...(config ? { created: true, config } : {}),
      })
    })
