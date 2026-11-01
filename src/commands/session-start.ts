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
import { type MailEndpoint, passwordCredential } from "../mail/backend.js"
import {
  type CredentialStorage,
  MICROSOFT_SCOPES,
  MICROSOFT_SMTP_SCOPE,
  microsoftClient,
  type OAuthKind,
  oauthKeeper,
  recordSignIn,
  SCOPE_WORDS,
  systemBrowser,
  tokenCredential,
} from "../oauth.js"
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

type Auth = "app-password" | "oauth"

const authOf = (value: string): Auth => {
  if (value !== "app-password" && value !== "oauth")
    throw new CliError("validation_error", "--auth takes app-password or oauth", { param: "auth" })
  return value
}

interface OAuthSignIn {
  endpoint: MailEndpoint
  address: string
  kind: OAuthKind
  prepare: Prepare
  storage: CredentialStorage
  browser: boolean
  created: (() => string) | undefined
}

/**
 * The browser sign-in of cli-core's keeper. `accept` logs in to IMAP with the new token before anything is saved
 * (WC-SECR-5): a refused login saves neither the sign-in nor the profile.
 */
const signInWithOAuth = async (command: Command, context: ReturnType<typeof contextOf>, given: OAuthSignIn) => {
  const { env, environment } = context
  const output = outputFor(command)
  const { client, source } = microsoftClient(context.settings.mailbox)
  output.renderer.note(
    [
      `Microsoft will ask you to let ${IDENTITY.command} (app ${source === "own" ? "of your own" : "of WireCat"}):`,
      ...MICROSOFT_SCOPES.map((scope) => `  - ${SCOPE_WORDS[scope] ?? scope}`),
    ].join("\n"),
  )
  const keeper = oauthKeeper({
    env,
    profile: context.profile,
    kind: given.kind,
    client,
    address: given.address,
    keyring: environment.keyring,
    storage: given.storage,
    fetch: environment.fetch,
    signal: environment.signal,
  })
  let folders: unknown
  let config: string | undefined
  const { scopes } = await baseContext(command, configuration.resolveSettings).run(() =>
    keeper.signIn({
      scopes: MICROSOFT_SCOPES,
      openBrowser: given.browser ? (environment.openBrowser ?? systemBrowser) : async () => {},
      showUrl: (url) => output.streams.diagnostic(`Open Microsoft sign-in: ${url}\n`),
      accept: async (tokens) => {
        if (!tokens.accessToken) throw new CliError("authentication_error", "Microsoft returned no access token")
        const { backend } = await openMail(context, {
          endpoint: given.endpoint,
          credential: tokenCredential(tokens.accessToken, given.kind),
        })
        folders = (await checkLogin(backend, given.prepare)).folders
        config = given.created?.()
        return undefined
      },
    }),
  )
  await recordSignIn(env, context.profile, {
    provider: given.kind,
    client: source,
    signed_in_at: new Date().toISOString(),
    scopes,
  })
  if (!scopes.includes(MICROSOFT_SMTP_SCOPE))
    output.renderer.note("Microsoft did not grant sending, so `messages send` will be refused; reading works")
  answer(command, {
    profile: context.profile,
    signed_in: true,
    login: given.endpoint.login,
    auth: "oauth",
    provider: given.kind,
    client: source,
    scopes,
    folders,
    ...(config ? { created: true, config } : {}),
  })
}

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
        `${IDENTITY.command} work session start --address me@outlook.com`,
      ],
    }),
  )
    .summary("sign in; a new profile is created first")
    .description(
      `sign this profile in. A new profile needs its mailbox: --address, or it is asked at a terminal; the server is found (built-in providers, the MX record, ISPDB, the domain's autoconfig; all providers: ${PROVIDERS_URL}); for a domain the built-in table does not know, the domain, never the address, goes to the DNS resolver, autoconfig.thunderbird.net and autoconfig.<domain>, and --provider or --host skips those lookups; the steps to prepare the mailbox are shown, the app password is asked (hidden) or read from ${IDENTITY.envPrefix}_PASSWORD, checked against the server, and only then the profile and the keyring entry are saved. Outlook.com and Microsoft 365 sign in with OAuth instead: the browser opens Microsoft's page, and the token is checked against the server before it is kept. An existing profile only asks for the password, or signs in, again. Without a terminal nothing is asked: a missing --address or password is a validation error`,
    )
    .option("--address <email>", "the full mail address of a new profile, also the login for most providers")
    .option("--provider <provider>", `skip discovery and use a built-in provider: ${PROVIDER_NAMES.join(", ")}`)
    .option("--host <host>", "skip discovery and use this IMAP host")
    .option("--port <port>", "IMAP port (default 993)")
    .option("--security <mode>", "tls or starttls (default tls)", securityOf)
    .option("--login <login>", "the login name, when it is not the full address")
    .option("--folder <folder>", "sync only this folder; repeat it for more", collect)
    .option("--auth <method>", "app-password or oauth; the default is what the provider takes", authOf)
    .option("--no-browser", "OAuth: print the sign-in link instead of opening the browser")
    .option(
      "--credential-storage <storage>",
      "where the password is kept: keyring (the default, which falls back to a private file by itself when no " +
        "keyring works), or file, not recommended",
      "keyring",
    )
    .action(async function (
      this: Command,
      flags: MailboxFlags & { address?: string; credentialStorage: string; auth?: Auth; browser: boolean },
    ) {
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
      let auth: Auth
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
        auth = context.settings.mailbox.auth
        if (flags.auth && flags.auth !== auth)
          throw new CliError(
            "validation_error",
            `profile ${context.profile} signs in with ${auth}; change that first: \`${IDENTITY.command} ${context.profile} config set auth ${flags.auth}\``,
            { param: "auth" },
          )
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
        if (found.auth === "oauth" && flags.auth === "app-password")
          throw new CliError("validation_error", `${found.provider} accepts only OAuth, never an app password`, {
            param: "auth",
          })
        auth = flags.auth ?? found.auth
        endpoint = { ...found.imap, login: found.login }
        provider = found.provider
        prepare = found.prepare
        created = () => writeProfile(env, context.profile, { ...profileOf(found, flags.folder), auth }, false).path
      }

      if (auth === "oauth") {
        const kind = providerFor(address, endpoint.host)?.oauth
        if (!kind)
          throw new CliError(
            "validation_error",
            `${provider} has no OAuth sign-in in ${IDENTITY.command}; it works for Outlook and Microsoft 365`,
            { param: "auth" },
          )
        output.renderer.note(
          `Server: ${endpoint.host}:${endpoint.port} (${endpoint.security}), login ${endpoint.login}`,
        )
        output.renderer.note(prepareText(provider, prepare))
        return signInWithOAuth(this, context, {
          endpoint,
          address,
          kind,
          prepare,
          storage,
          browser: flags.browser,
          created,
        })
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
      const { backend } = await openMail(context, { endpoint, credential: passwordCredential(typed) })
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
