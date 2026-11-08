import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { memoryKeyring, resolvePaths } from "@wirecat/cli-base"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { MailEnvironment } from "./commands/context.js"
import { runsDir } from "./mail/changes.js"
import { GOOGLE_MAIL_SCOPE, oauthStorage, recordSignIn, signInRecords } from "./oauth.js"
import { run } from "./program.js"
import { passwordStore } from "./secret.js"

const item = (text: string) => JSON.parse(text).item
const failure = (err: string) => JSON.parse(err.trim().split("\n").at(-1) ?? "{}").error

const setup = async () => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MAIL_CONFIG_DIR: mkdtempSync(join(tmpdir(), "config-")),
    MAIL_STATE_DIR: mkdtempSync(join(tmpdir(), "state-")),
    MESSAGING_STORE: join(mkdtempSync(join(tmpdir(), "store-")), "wirecat.db"),
  }
  const paths = resolvePaths({ appName: "mail-cli", prefix: "MAIL", env })
  const keyring = memoryKeyring()
  writeFileSync(
    join(paths.config, "config.json"),
    JSON.stringify({
      profiles: {
        work: { address: "me@gmail.com", auth: "oauth", imap_host: "imap.gmail.com" },
        outlook: { address: "me@outlook.com", auth: "oauth", imap_host: "outlook.office365.com" },
        home: { address: "me@example.com", imap_host: "imap.example.com" },
      },
    }),
  )
  const signIn = async (profile: string, kind: "google" | "microsoft", address: string) => {
    oauthStorage({ env, profile, kind, keyring }).write(
      {
        tokens: {
          accessToken: "a",
          refreshToken: `refresh-of-${profile}`,
          expiresAt: Date.now() + 3_600_000,
          scopes: [GOOGLE_MAIL_SCOPE],
        },
        client: { clientId: "synthetic-client" },
      },
      { signIn: true },
    )
    await recordSignIn(env, profile, {
      provider: kind,
      client: "own",
      signed_in_at: new Date().toISOString(),
      scopes: [],
    })
    const changes = runsDir(env, address)
    mkdirSync(changes, { recursive: true })
    writeFileSync(join(changes, "run.jsonl"), "{}\n")
  }
  await signIn("work", "google", "me@gmail.com")
  await signIn("outlook", "microsoft", "me@outlook.com")
  passwordStore({ env, profile: "home", keyring }).write("synthetic-password")
  const revoked = vi.fn(async (_url: unknown, _init?: unknown) => new Response("", { status: 200 }))
  vi.stubGlobal("fetch", revoked)
  const mail = async (argv: string[]) => {
    const out: string[] = []
    const err: string[] = []
    const code = await run(argv, {
      streams: { data: (text) => out.push(text), diagnostic: (text) => err.push(text) },
      tty: false,
      env,
      keyring,
      himalaya: async () => undefined,
    } satisfies MailEnvironment)
    return { code, out: out.join("\n"), err: err.join("\n") }
  }
  const remove = (profile: string, ...args: string[]) =>
    mail([profile, "account", "remove", "--json", "--yes", ...args])
  const has = (kind: "google" | "microsoft", profile: string) =>
    oauthStorage({ env, profile, kind, keyring }).read() !== undefined
  return { env, keyring, revoked, mail, remove, has, paths }
}

describe("mail account remove", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("refuses to choose what happens to the data", async () => {
    const t = await setup()
    const refused = await t.remove("work")
    expect(failure(refused.err)).toMatchObject({ reason: "account-remove.no-choice" })
    expect(t.has("google", "work")).toBe(true)
  })

  it("revokes only this Google sign-in, forgets it and its record, and leaves the other profiles alone", async () => {
    const t = await setup()
    const removed = await t.remove("work", "--keep-data")

    expect(removed.code, removed.err).toBe(0)
    expect(item(removed.out)).toMatchObject({
      account: { provider: "email", account: "me@gmail.com" },
      revoked: true,
    })
    expect(t.revoked).toHaveBeenCalledTimes(1)
    expect(String(t.revoked.mock.calls[0]?.[0])).toContain("/revoke")
    expect(String((t.revoked.mock.calls[0]?.[1] as RequestInit | undefined)?.body)).toContain("refresh-of-work")
    expect(t.has("google", "work")).toBe(false)
    expect(Object.keys(signInRecords(t.env))).toEqual(["outlook"])
    expect(existsSync(runsDir(t.env, "me@gmail.com"))).toBe(true)

    expect(t.has("microsoft", "outlook")).toBe(true)
    expect(existsSync(runsDir(t.env, "me@outlook.com"))).toBe(true)
    expect((await passwordStore({ env: t.env, profile: "home", keyring: t.keyring }).read())?.secret).toBe(
      "synthetic-password",
    )
  })

  it("deletes the change logs with --delete-data", async () => {
    const t = await setup()
    await t.remove("work", "--delete-data")

    expect(existsSync(runsDir(t.env, "me@gmail.com"))).toBe(false)
    expect(existsSync(runsDir(t.env, "me@outlook.com"))).toBe(true)
  })

  it("forgets a Microsoft sign-in without a revoke, since a public client cannot make one", async () => {
    const t = await setup()
    const removed = await t.remove("outlook", "--keep-data")

    expect(removed.code, removed.err).toBe(0)
    expect(item(removed.out).revoked).toBeNull()
    expect(t.revoked).not.toHaveBeenCalled()
    expect(t.has("microsoft", "outlook")).toBe(false)
    expect(t.has("google", "work")).toBe(true)
  })

  it("forgets an app password and calls nobody", async () => {
    const t = await setup()
    const removed = await t.remove("home", "--keep-data")

    expect(removed.code, removed.err).toBe(0)
    expect(t.revoked).not.toHaveBeenCalled()
    expect(await passwordStore({ env: t.env, profile: "home", keyring: t.keyring }).read()).toBeUndefined()
    expect(t.has("google", "work")).toBe(true)
  })

  it("succeeds for a profile that is already signed out", async () => {
    const t = await setup()
    oauthStorage({ env: t.env, profile: "work", kind: "google", keyring: t.keyring }).remove()

    const removed = await t.remove("work", "--keep-data")

    expect(removed.code, removed.err).toBe(0)
    expect(t.revoked).not.toHaveBeenCalled()
    expect(Object.keys(signInRecords(t.env))).toEqual(["outlook"])
  })

  it("lists what it would remove with --dry-run and changes nothing", async () => {
    const t = await setup()
    const preview = await t.remove("work", "--delete-data", "--dry-run")

    expect(item(preview.out)).toMatchObject({ dry_run: true })
    expect(item(preview.out).removed).toContainEqual({ kind: "keyring", target: "oauth:google:work" })
    expect(t.has("google", "work")).toBe(true)
    expect(existsSync(runsDir(t.env, "me@gmail.com"))).toBe(true)
  })

  it("refuses while a serve runs for the profile and removes nothing", async () => {
    const t = await setup()
    mkdirSync(join(t.paths.state, "serve"), { recursive: true })
    writeFileSync(
      join(t.paths.state, "serve", "work.lock"),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    )

    const refused = await t.remove("work", "--delete-data")

    expect(failure(refused.err)).toMatchObject({ reason: "account-remove.busy" })
    expect(t.has("google", "work")).toBe(true)
    expect(t.revoked).not.toHaveBeenCalled()
  })
})
