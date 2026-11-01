import type { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { memoryKeyring } from "@wirecat/cli-base"
import { afterEach, describe, expect, it } from "vitest"
import type { MailEnvironment } from "./commands/context.js"
import type { MailCredential, MailEndpoint, RunBounds } from "./mail/backend.js"
import { imapBackend } from "./mail/imap/index.js"
import { GOOGLE_MAIL_SCOPE, MICROSOFT_IMAP_SCOPE, MICROSOFT_SMTP_SCOPE, systemBrowser } from "./oauth.js"
import { run } from "./program.js"
import { providerFor } from "./providers.js"
import { type FakeImap, startFakeImap } from "./testing/fake-imap.js"
import { type FakeSmtp, startFakeSmtp } from "./testing/fake-smtp.js"

const CLIENT = "11111111-2222-3333-4444-555555555555"

let imap: FakeImap | undefined
let smtp: FakeSmtp | undefined
afterEach(async () => {
  await imap?.close()
  await smtp?.close()
  imap = undefined
  smtp = undefined
})

const message = (address: string) =>
  `Message-ID: <hello@example.com>\r\nDate: Tue, 27 Oct 2026 10:00:00 +0000\r\nFrom: Ann <ann@example.com>\r\n` +
  `To: ${address}\r\nSubject: Hello\r\n\r\nHi there\r\n`

/**
 * A fake provider: a token endpoint (with Google's userinfo and revoke), a browser that consents at once, and IMAP and
 * SMTP that take only its tokens.
 */
const harness = async (
  address = "me@outlook.com",
  mx = "mx.example.net",
  granted = `${MICROSOFT_IMAP_SCOPE} ${MICROSOFT_SMTP_SCOPE}`,
) => {
  const accepted: string[] = []
  const sendable: string[] = []
  imap = await startFakeImap({
    login: address,
    password: "no-password-here",
    tokens: accepted,
    folders: [
      { name: "INBOX", messages: [{ uid: 1, raw: message(address), flags: [] }] },
      { name: "Sent Items", attributes: ["\\Sent"], messages: [] },
    ],
  })
  smtp = await startFakeSmtp({ login: address, password: "no-password-here", tokens: sendable })
  const ports = { imap: imap.port, smtp: smtp.port }
  const keyring = memoryKeyring()
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MAIL_CONFIG_DIR: mkdtempSync(join(tmpdir(), "config-")),
    MAIL_STATE_DIR: mkdtempSync(join(tmpdir(), "state-")),
    MEMO_STATE_DIR: mkdtempSync(join(tmpdir(), "memo-state-")),
    MESSAGING_STORE: join(mkdtempSync(join(tmpdir(), "store-")), "wirecat.db"),
  }
  delete env.CI
  const server = {
    accepts: true,
    sends: true,
    issued: 0,
    account: address,
    revoked: 0,
    lookup: "ok" as "ok" | "refused" | "down" | "unverified",
  }
  const tokenCalls: URLSearchParams[] = []
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("/userinfo")) {
      if (server.lookup === "down") throw new TypeError("fetch failed")
      if (server.lookup === "refused") return new Response("", { status: 401 })
      return Response.json({ email: server.account, email_verified: server.lookup !== "unverified" })
    }
    if (String(url).includes("/revoke")) {
      server.revoked += 1
      return new Response("", { status: 200 })
    }
    const body = new URLSearchParams(String(init?.body))
    tokenCalls.push(body)
    server.issued += 1
    const access = `synthetic-access-${server.issued}`
    if (server.accepts) accepted.push(access)
    if (server.sends) sendable.push(access)
    return Response.json({
      access_token: access,
      refresh_token: `synthetic-refresh-${server.issued}`,
      expires_in: 3600,
      scope: granted,
      token_type: "Bearer",
    })
  }) as typeof globalThis.fetch
  const authorizeUrls: URL[] = []
  const browser = { opened: 0 }
  const consent = async (url: string) => {
    const authorize = new URL(url)
    authorizeUrls.push(authorize)
    const callback = new URL(authorize.searchParams.get("redirect_uri") ?? "")
    callback.search = new URLSearchParams({
      code: "synthetic-code",
      state: authorize.searchParams.get("state") ?? "",
    }).toString()
    await globalThis.fetch(callback)
  }
  const openBrowser = async (url: string) => {
    browser.opened += 1
    await consent(url)
  }
  const streams: string[] = []
  /** Follows the printed sign-in link, as a person does after `--no-browser`. */
  const followLink = (text: string) => {
    const link = /sign-in: (\S+)/.exec(text)?.[1]
    if (link) void consent(link)
  }
  const mail = async (argv: string[], more: NodeJS.ProcessEnv = {}) => {
    const out: string[] = []
    const err: string[] = []
    const code = await run(argv, {
      streams: {
        data: (text) => out.push(text),
        diagnostic: (text) => {
          err.push(text)
          if (argv.includes("--no-browser")) followLink(text)
        },
      },
      tty: false,
      env: { ...env, ...more },
      keyring,
      himalaya: async () => undefined,
      discovery: { mx: async () => [mx], fetch: async () => new Response("", { status: 404 }) },
      stdin: Readable.from([]),
      fetch,
      openBrowser,
      backend: (endpoint: MailEndpoint, credential: MailCredential, bounds: RunBounds = {}) =>
        imapBackend(
          {
            ...endpoint,
            host: "127.0.0.1",
            port: ports.imap,
            security: "plain",
            ...(endpoint.smtp ? { smtp: { host: "127.0.0.1", port: ports.smtp, security: "plain" } } : {}),
          },
          credential,
          { sleep: async () => {}, ...bounds },
        ),
    } as MailEnvironment & Record<string, unknown>)
    streams.push(...out, ...err)
    return { code, out: out.join("\n"), err: err.join("\n") }
  }
  const config = () => JSON.parse(readFileSync(join(env.MAIL_CONFIG_DIR as string, "config.json"), "utf8"))
  const entry = (kind = "microsoft") => keyring.get("mail-cli", `oauth:${kind}:work`)
  const leaked = () => streams.join("\n").match(/synthetic-(access|refresh)/)
  return { mail, env, config, entry, leaked, server, accepted, sendable, tokenCalls, authorizeUrls, keyring, browser }
}

const item = (text: string) => JSON.parse(text).item
/** The error is the last line of stderr; notes may come before it. */
const failure = (err: string) => JSON.parse(err.trim().split("\n").at(-1) ?? "{}").error

const ownApp = async (mail: Awaited<ReturnType<typeof harness>>["mail"]) => {
  const set = await mail(["config", "set", "--defaults", "microsoft_client_id", CLIENT, "--json"])
  expect(set.code, set.err).toBe(0)
}

describe("Microsoft sign-in", { timeout: 20_000 }, () => {
  it("signs in to Outlook in the browser, checks IMAP before saving, then syncs and sends with the token", async () => {
    const { mail, config, entry, leaked, tokenCalls, authorizeUrls, sendable } = await harness()
    await ownApp(mail)
    const started = await mail(["work", "session", "start", "--address", "me@outlook.com", "--json"])
    expect(started.code, started.err).toBe(0)
    expect(item(started.out)).toMatchObject({
      signed_in: true,
      auth: "oauth",
      provider: "microsoft",
      client: "own",
      created: true,
      scopes: [MICROSOFT_IMAP_SCOPE, MICROSOFT_SMTP_SCOPE],
    })
    expect(started.err).toContain("read and change your mail over IMAP")
    expect(authorizeUrls[0]?.searchParams.get("client_id")).toBe(CLIENT)
    expect(authorizeUrls[0]?.searchParams.get("login_hint")).toBe("me@outlook.com")
    expect(authorizeUrls[0]?.searchParams.get("scope")).toContain("offline_access")
    expect(tokenCalls[0]?.get("code_verifier")).toBeTruthy()
    expect(tokenCalls[0]?.has("client_secret")).toBe(false)
    expect(config().profiles.work).toMatchObject({ address: "me@outlook.com", auth: "oauth" })
    expect(JSON.parse(entry() ?? "{}")).toMatchObject({ provider: "microsoft", clientId: CLIENT })

    const synced = await mail(["work", "sync", "--since-time", "2026-01-01", "--json"])
    expect(synced.code, synced.err).toBe(0)
    const sent = await mail(["work", "messages", "send", "--to", "me@outlook.com", "--subject", "Self", "Hi", "--json"])
    expect(sent.code, sent.err).toBe(0)
    expect(item(sent.out)).toMatchObject({ sent: true, accepted: 1 })
    expect(smtp?.tokensTried).toEqual([sendable[0]])
    expect(leaked()).toBeNull()
  })

  it("prints the link instead of opening the browser with --no-browser", async () => {
    const { mail, browser } = await harness()
    await ownApp(mail)
    const started = await mail(["work", "session", "start", "--address", "me@outlook.com", "--no-browser", "--json"])
    expect(started.code, started.err).toBe(0)
    expect(started.err).toContain("Open Microsoft sign-in: https://login.microsoftonline.com/common/oauth2/v2.0/")
    expect(browser.opened).toBe(0)
  })

  it("saves neither the sign-in nor the profile when the server refuses the new token", async () => {
    const { mail, env, entry, server } = await harness()
    await ownApp(mail)
    server.accepts = false
    const refused = await mail(["work", "session", "start", "--address", "me@outlook.com", "--json"])
    expect(refused.code).not.toBe(0)
    expect(entry()).toBeNull()
    const profiles = await mail(["session", "list", "--json"])
    expect(JSON.parse(profiles.out).items).toEqual([])
    expect(readFileSync(join(env.MAIL_CONFIG_DIR as string, "config.json"), "utf8")).not.toContain("outlook.com")
  })

  it("refreshes once when the server refuses a token that still looks fresh, then asks for a new sign-in", async () => {
    const { mail, accepted, server, tokenCalls, leaked } = await harness()
    await ownApp(mail)
    expect((await mail(["work", "session", "start", "--address", "me@outlook.com", "--json"])).code).toBe(0)
    accepted.splice(0)
    const synced = await mail(["work", "sync", "--since-time", "2026-01-01", "--json"])
    expect(synced.code, synced.err).toBe(0)
    expect(tokenCalls.map((call) => call.get("grant_type"))).toEqual(["authorization_code", "refresh_token"])
    expect(tokenCalls[1]?.get("refresh_token")).toBe("synthetic-refresh-1")

    accepted.splice(0)
    server.accepts = false
    const again = await mail(["work", "sync", "--json"])
    expect(again.code).not.toBe(0)
    expect(failure(again.err)).toMatchObject({ reason: "mail.oauth-refused" })
    expect(again.err).toContain("mail work session start")
    expect(tokenCalls).toHaveLength(3)
    expect(leaked()).toBeNull()
  })

  it("says how to set an app id when this build has none, and keeps nothing", async () => {
    const { mail, entry } = await harness()
    const started = await mail(["work", "session", "start", "--address", "me@outlook.com", "--json"])
    expect(started.code).not.toBe(0)
    expect(failure(started.err)).toMatchObject({ reason: "mail.oauth-no-client" })
    expect(started.err).toContain("config set --defaults microsoft_client_id")
    expect(entry()).toBeNull()
  })

  it("shows the sign-in without tokens, and session end forgets it and names where Microsoft lists the app", async () => {
    const { mail, entry, leaked } = await harness()
    await ownApp(mail)
    expect((await mail(["work", "session", "start", "--address", "me@outlook.com", "--json"])).code).toBe(0)
    const status = await mail(["work", "session", "status", "--check", "--json"])
    expect(status.code, status.err).toBe(0)
    expect(item(status.out)).toMatchObject({
      state: "saved",
      auth: "oauth",
      verified: true,
      oauth: { provider: "microsoft", client: "own", scopes: [MICROSOFT_IMAP_SCOPE, MICROSOFT_SMTP_SCOPE] },
    })
    expect(item(status.out).oauth.signed_in_at).toBeTruthy()

    const doctor = await mail(["doctor", "--json"])
    expect(item(doctor.out).oauth).toEqual([
      { profile: "work", provider: "microsoft", client: "own", signed_in_at: expect.any(String), sends: true },
    ])

    const ended = await mail(["work", "session", "end", "--json"])
    expect(item(ended.out)).toMatchObject({ ended: true, mail: "retained" })
    expect(ended.err).toContain("account.live.com")
    expect(entry()).toBeNull()
    expect(item((await mail(["work", "session", "status", "--json"])).out)).toMatchObject({ state: "missing" })
    expect((await mail(["doctor", "--json"])).err).toContain("no OAuth sign-in on record")
    expect(leaked()).toBeNull()
  })
})

describe("Microsoft 365", { timeout: 20_000 }, () => {
  it("is found by its MX, sends through smtp.office365.com, and names SMTP AUTH when sending is refused", async () => {
    expect(providerFor("me@contoso.example", "outlook.office365.com")?.smtp.host).toBe("smtp.office365.com")
    expect(providerFor("me@outlook.com", "outlook.office365.com")?.smtp.host).toBe("smtp-mail.outlook.com")
    const { mail, config, server } = await harness("me@contoso.example", "contoso-example.mail.protection.outlook.com")
    await ownApp(mail)
    server.sends = false
    const started = await mail(["work", "session", "start", "--address", "me@contoso.example", "--json"])
    expect(started.code, started.err).toBe(0)
    expect(started.err).toContain("Authenticated SMTP")
    expect(config().profiles.work).toMatchObject({ imap_host: "outlook.office365.com", auth: "oauth" })
    expect((await mail(["work", "sync", "--since-time", "2026-01-01", "--json"])).code).toBe(0)
    const sent = await mail(["work", "messages", "send", "--to", "me@contoso.example", "--subject", "S", "x", "--json"])
    expect(sent.code, sent.err).not.toBe(0)
    expect(failure(sent.err), sent.err).toMatchObject({ reason: "mail.smtp-auth-disabled" })
  })
})

describe("Gmail with your own Google app", { timeout: 20_000 }, () => {
  const gmail = () => harness("me@gmail.com", "aspmx.l.google.com", `openid email ${GOOGLE_MAIL_SCOPE}`)
  const clientFile = (mode = 0o600) => {
    const file = join(mkdtempSync(join(tmpdir(), "client-")), "client.json")
    writeFileSync(file, JSON.stringify({ installed: { client_id: "own-client", client_secret: "own-public-secret" } }))
    chmodSync(file, mode)
    return file
  }
  const start = ["work", "session", "start", "--address", "me@gmail.com", "--json"]

  it("signs in with the client file, keeps its secret to refresh, and checks the account", async () => {
    const { mail, entry, accepted, tokenCalls, config, leaked } = await gmail()
    const started = await mail([...start, "--client-file", clientFile()])
    expect(started.code, started.err).toBe(0)
    expect(item(started.out)).toMatchObject({ provider: "google", client: "own" })
    expect(config().profiles.work).toMatchObject({ imap_host: "imap.gmail.com", auth: "oauth" })
    expect(JSON.parse(entry("google") ?? "{}")).toMatchObject({
      clientId: "own-client",
      clientSecret: "own-public-secret",
    })
    accepted.splice(0)
    const checked = await mail(["work", "session", "status", "--check", "--json"])
    expect(checked.code, checked.err).toBe(0)
    expect(tokenCalls[1]?.get("grant_type")).toBe("refresh_token")
    expect(tokenCalls[1]?.get("client_secret")).toBe("own-public-secret")
    expect(leaked()).toBeNull()
  })

  it("refuses another Google account and a client file others can read, keeping nothing", async () => {
    const { mail, entry, server } = await gmail()
    if (process.platform !== "win32")
      expect(failure((await mail([...start, "--client-file", clientFile(0o644)])).err)).toMatchObject({
        reason: "sign-in.client-file-open",
      })
    server.account = "someone.else@gmail.com"
    const wrong = await mail([...start, "--client-file", clientFile()])
    expect(failure(wrong.err)).toMatchObject({ reason: "profile.wrong-account" })
    expect(entry("google")).toBeNull()
    expect(JSON.parse((await mail(["session", "list", "--json"])).out).items).toEqual([])
  })

  it("doctor warns from day 6 about a Testing app, and session end --revoke asks Google once", async () => {
    const { mail, env, entry, server } = await gmail()
    expect((await mail([...start, "--client-file", clientFile()])).code).toBe(0)
    expect((await mail(["doctor", "--json"])).err).not.toContain("Testing")
    const records = join(env.MAIL_STATE_DIR as string, "sign-ins.json")
    const saved = JSON.parse(readFileSync(records, "utf8"))
    saved.work.signed_in_at = new Date(Date.now() - 6.5 * 86_400_000).toISOString()
    writeFileSync(records, JSON.stringify(saved))
    const doctor = await mail(["doctor", "--json"])
    expect(item(doctor.out).oauth[0]).toMatchObject({ provider: "google", testing_expiry_risk: true })
    expect(doctor.err).toContain("Testing")

    const ended = await mail(["work", "session", "end", "--revoke", "--json"])
    expect(item(ended.out)).toMatchObject({ ended: true, revoked: true })
    expect(ended.err).toContain("every sign-in of this Google project")
    expect(server.revoked).toBe(1)
    expect(entry("google")).toBeNull()
  })
})

describe("Google sign-in edges", { timeout: 20_000 }, () => {
  const gmail = () => harness("me@gmail.com", "aspmx.l.google.com", `openid email ${GOOGLE_MAIL_SCOPE}`)
  const file = () => {
    const path = join(mkdtempSync(join(tmpdir(), "client-")), "client.json")
    writeFileSync(path, JSON.stringify({ installed: { client_id: "own-client" } }), { mode: 0o600 })
    return path
  }
  const start = ["work", "session", "start", "--address", "me@gmail.com", "--json"]

  it("fails the sign-in when Google's account lookup is down, refused or unverified", async () => {
    const { mail, server, entry } = await gmail()
    for (const [lookup, code] of [
      ["down", "provider_unavailable"],
      ["refused", "authentication_error"],
      ["unverified", "authentication_error"],
    ] as const) {
      server.lookup = lookup
      expect(failure((await mail([...start, "--client-file", file()])).err), lookup).toMatchObject({ code })
    }
    expect(entry("google")).toBeNull()
  })

  it("signs an OAuth Gmail profile in again with MAIL_GOOGLE_CLIENT_ID, and names the guide without one", async () => {
    const { mail, authorizeUrls } = await gmail()
    expect((await mail([...start, "--client-file", file()])).code).toBe(0)
    const again = await mail(["work", "session", "start", "--json"], { MAIL_GOOGLE_CLIENT_ID: "env-client" })
    expect(again.code, again.err).toBe(0)
    expect(authorizeUrls.at(-1)?.searchParams.get("client_id")).toBe("env-client")
    const none = await mail(["work", "session", "start", "--json"])
    expect(failure(none.err)).toMatchObject({ reason: "mail.oauth-no-client" })
    expect(none.err).toContain("oauth-google.md")
  })
})

describe("the system browser", () => {
  const fakeSpawn = (event: "spawn" | "error", seen: string[][]) =>
    ((command: string, args: string[]) => {
      seen.push([command, ...args])
      const child = Object.assign(new EventEmitter(), { unref: () => {} })
      queueMicrotask(() => child.emit(event))
      return child
    }) as unknown as typeof spawn

  it("opens the link with each platform's opener, and says so when none starts", async () => {
    const seen: string[][] = []
    for (const platform of ["linux", "darwin", "win32"] as const)
      await systemBrowser("https://example.test/x", platform, fakeSpawn("spawn", seen))
    expect(seen.map(([command]) => command)).toEqual(["xdg-open", "open", "rundll32.exe"])
    await expect(systemBrowser("https://example.test/x", "linux", fakeSpawn("error", seen))).rejects.toMatchObject({
      code: "configuration_error",
    })
  })
})
