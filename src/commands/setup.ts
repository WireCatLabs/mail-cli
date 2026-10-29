import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import {
  environmentOf,
  FETCH,
  itemOf,
  outputFor,
  profileFree,
  refuseUnderReadOnly,
  renderAnswer,
  secretInputOf,
} from "@wirecat/cli-core/cli"
import { Command } from "commander"
import { type Discovery, discover, discoverByName, domainOf, PROVIDER_NAMES, type Security } from "../discovery.js"
import { IDENTITY } from "../identity.js"
import { imapSource } from "../mail/imap.js"
import { profileOf, proposedName, writeProfile } from "../profile.js"
import { GENERIC_PREPARE, PROVIDERS_URL, prepareText } from "../providers.js"
import { passwordStore } from "../secret.js"
import { collect, type MailEnvironment } from "./context.js"
import { checkLogin } from "./login.js"

interface SetupFlags {
  name?: string
  provider?: string
  host?: string
  port?: string
  security?: Security
  login?: string
  folder?: string[]
  replace?: boolean
}

const securityOf = (value: string): Security => {
  if (value !== "tls" && value !== "starttls")
    throw new CliError("validation_error", "--security takes tls or starttls; a plain connection is refused")
  return value
}

const portOf = (value: string): number => {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new CliError("validation_error", "--port takes a port number")
  return port
}

/** Asks at a terminal which built-in provider hosts the address; an empty answer gives up. */
type Pick = () => Promise<string | undefined>

const discovered = async (address: string, flags: SetupFlags, environment: MailEnvironment, pick?: Pick) => {
  if (flags.provider) return discoverByName(address, flags.provider)
  try {
    return await discover(
      address,
      environment.discovery ?? { ...(environment.signal ? { signal: environment.signal } : {}) },
    )
  } catch (error) {
    if (!(error instanceof CliError) || error.code !== "not_found" || !pick) throw error
    const name = await pick()
    if (!name) throw error
    return discoverByName(address, name)
  }
}

const chosen = async (
  address: string,
  flags: SetupFlags,
  environment: MailEnvironment,
  pick?: Pick,
): Promise<Discovery> => {
  if (!flags.host) {
    const found = await discovered(address, flags, environment, pick)
    return {
      ...found,
      ...(flags.login ? { login: flags.login } : {}),
      imap: {
        ...found.imap,
        ...(flags.port ? { port: portOf(flags.port) } : {}),
        ...(flags.security ? { security: flags.security } : {}),
      },
    }
  }
  domainOf(address)
  return {
    address,
    provider: "custom",
    imap: { host: flags.host, port: flags.port ? portOf(flags.port) : 993, security: flags.security ?? "tls" },
    login: flags.login ?? address,
    auth: "app-password",
    found_by: "built-in",
    prepare: GENERIC_PREPARE,
  }
}

export const setupCommand = (): Command =>
  profileFree(
    annotate(new Command("setup"), {
      effects: FETCH,
      examples: [
        `${IDENTITY.command} setup ya@burobiz.ru`,
        `${IDENTITY.command} setup ya@burobiz.ru --name ya --yes`,
        `${IDENTITY.command} setup me@example.com --host imap.example.com --security tls --yes`,
      ],
    }),
  )
    .summary("find a mailbox's server and save it as a profile")
    .description(
      `find the IMAP server for an address (built-in providers, the MX record, ISPDB, the domain's autoconfig), show it with the steps to prepare the mailbox (turn on IMAP, make an app password; all providers: ${PROVIDERS_URL}), and save a profile when you confirm, then ask for the app password and keep it in the keyring (at a terminal; with --yes or --json nothing is asked and the next command is printed)`,
    )
    .argument("<address>", "the full mail address, also the login for most providers")
    .option("--name <name>", "the profile name (default: the part before the @)")
    .option("--provider <provider>", `skip discovery and use a built-in provider: ${PROVIDER_NAMES.join(", ")}`)
    .option("--host <host>", "skip discovery and use this IMAP host")
    .option("--port <port>", "IMAP port (default 993)")
    .option("--security <mode>", "tls or starttls (default tls)", securityOf)
    .option("--login <login>", "the login name, when it is not the full address")
    .option("--folder <folder>", "sync only this folder; repeat it for more", collect)
    .option("--replace", "overwrite a profile of the same name")
    .action(async function (this: Command, address: string, flags: SetupFlags) {
      const environment = environmentOf<MailEnvironment>(this)
      const env = environment.env ?? process.env
      const mail = address.trim().toLowerCase()
      const output = outputFor(this)
      const yes = this.optsWithGlobals<{ yes?: boolean }>().yes === true
      const asking = !yes && environment.tty !== false
      const pick: Pick | undefined = asking
        ? async () => {
            const { readSecret } = await import("@wirecat/cli-core")
            output.renderer.note(`No server found for ${mail}. Built-in providers: ${PROVIDER_NAMES.join(", ")}`)
            const named = await readSecret("Which one hosts this mailbox? (empty to give up) ", {
              ...secretInputOf(this),
              echo: true,
            })
            return named.trim() || undefined
          }
        : undefined
      const found = await chosen(mail, flags, environment, pick)
      const name = flags.name ?? proposedName(mail)
      const next = `${IDENTITY.command} ${name} session start`
      const shown = {
        profile: name,
        address: found.address,
        provider: found.provider,
        found_by: found.found_by,
        imap: found.imap,
        login: found.login,
        auth: found.auth,
        ...(found.note ? { note: found.note } : {}),
        ...(output.format === "pretty" ? {} : { prepare: found.prepare }),
      }

      if (output.format === "pretty") {
        output.renderer.note(
          `${found.provider}: imap ${found.imap.host}:${found.imap.port} (${found.imap.security}), login ${found.login}`,
        )
        output.renderer.note(prepareText(found.provider, found.prepare))
      }
      let save = yes
      if (asking) {
        const { readSecret } = await import("@wirecat/cli-core")
        const answer = await readSecret(`Save profile ${name}? [y/N] `, { ...secretInputOf(this), echo: true })
        save = /^y(es)?$/i.test(answer.trim())
      }
      if (!save) return renderAnswer(this, output, itemOf({ ...shown, saved: false }))
      if (found.auth === "oauth")
        throw new CliError(
          "validation_error",
          `${found.provider} accepts only OAuth for IMAP, which this version cannot do yet`,
          {
            param: "address",
          },
        )
      refuseUnderReadOnly(this, "setup")
      const { path } = writeProfile(env, name, profileOf(found, flags.folder), flags.replace === true)

      let signedIn = false
      if (asking && output.format === "pretty") {
        const { readSecret } = await import("@wirecat/cli-core")
        const typed = await readSecret(
          `App password for ${found.login} (hidden; empty to do it later with \`${next}\`): `,
          secretInputOf(this),
        )
        if (typed) {
          try {
            await checkLogin(
              environment.connect ?? imapSource,
              { ...found.imap, login: found.login },
              typed,
              found.address,
              found.prepare,
            )
          } catch (error) {
            if (!(error instanceof CliError)) throw error
            throw new CliError(
              error.code,
              `${error.message} The profile ${name} is saved; run \`${next}\` to try again.`,
              error.details,
            )
          }
          passwordStore({
            env,
            profile: name,
            keyring: environment.keyring,
            himalaya: environment.himalaya,
          }).write(typed)
          signedIn = true
        }
      }
      renderAnswer(
        this,
        output,
        itemOf(
          { ...shown, saved: true, config: path, signed_in: signedIn, ...(signedIn ? {} : { next_command: next }) },
          { next: [] },
        ),
      )
    })
