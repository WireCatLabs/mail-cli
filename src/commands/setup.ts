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
import { type Discovery, discover, domainOf, type Security } from "../discovery.js"
import { IDENTITY } from "../identity.js"
import { profileOf, proposedName, writeProfile } from "../profile.js"
import { collect, type MailEnvironment } from "./context.js"

interface SetupFlags {
  name?: string
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

const chosen = async (address: string, flags: SetupFlags, environment: MailEnvironment): Promise<Discovery> => {
  if (!flags.host) {
    const found = await discover(
      address,
      environment.discovery ?? { ...(environment.signal ? { signal: environment.signal } : {}) },
    )
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
      "find the IMAP server for an address (built-in providers, the MX record, ISPDB, the domain's autoconfig), show it, and save a profile when you confirm; no password is asked here",
    )
    .argument("<address>", "the full mail address, also the login for most providers")
    .option("--name <name>", "the profile name (default: the part before the @)")
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
      const found = await chosen(mail, flags, environment)
      const name = flags.name ?? proposedName(mail)
      const output = outputFor(this)
      const shown = {
        profile: name,
        address: found.address,
        provider: found.provider,
        found_by: found.found_by,
        imap: found.imap,
        login: found.login,
        auth: found.auth,
        ...(found.note ? { note: found.note } : {}),
      }

      let save = this.optsWithGlobals<{ yes?: boolean }>().yes === true
      if (!save && environment.tty !== false) {
        const { readSecret } = await import("@wirecat/cli-core")
        output.renderer.note(
          `${found.provider}: imap ${found.imap.host}:${found.imap.port} (${found.imap.security}), login ${found.login}${found.note ? `\n${found.note}` : ""}`,
        )
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
      renderAnswer(this, output, itemOf({ ...shown, saved: true, config: path }, { next: [] }))
    })
