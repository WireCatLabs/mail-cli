import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { expect, it } from "vitest"
import { configPath, writeProfile } from "./profile.js"

const PROFILE = { address: "someone@example.com", imap_host: "imap.example.com", auth: "app-password" }
const envIn = () => ({ ...process.env, MAIL_CONFIG_DIR: mkdtempSync(join(tmpdir(), "mail-profile-")) })

it("the first file a new profile writes holds every setting at its default", () => {
  const env = envIn()
  const { path } = writeProfile(env, "work", PROFILE, false)
  const saved = JSON.parse(readFileSync(path, "utf8"))
  expect(saved.profiles).toEqual({ work: PROFILE })
  expect(saved.defaults).toMatchObject({ limit: 20, record: true, keep_runs_for_days: 30 })
})

it("adding a profile keeps the owner's settings, their order and keys mail does not know", () => {
  const env = envIn()
  mkdirSync(dirname(configPath(env)), { recursive: true })
  writeFileSync(configPath(env), JSON.stringify({ defaults: { limit: 5 }, future_key: 1, profiles: {} }))
  writeProfile(env, "work", PROFILE, false)
  const saved = JSON.parse(readFileSync(configPath(env), "utf8"))
  expect(Object.keys(saved)).toEqual(["defaults", "future_key", "profiles"])
  expect(saved.defaults).toMatchObject({ limit: 5, record: true })
  expect(Object.keys(saved.defaults)[0]).toBe("limit")
})
