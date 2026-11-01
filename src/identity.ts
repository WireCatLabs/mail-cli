import type { AppIdentity } from "@wirecat/cli-core/cli"
import { VERSION } from "./version.js"

export const PACKAGE = "@wirecat/mail-cli"

export const IDENTITY: AppIdentity = {
  command: "mail",
  appName: "mail-cli",
  envPrefix: "MAIL",
  description: "read mail over IMAP into the shared store and search it, with app passwords kept in the OS keyring",
  version: VERSION,
  issues: "https://github.com/WireCatLabs/mail-cli/issues/new",
  messenger: false,
  // One call to the source reads 60 messages on 4 connections: 5 to 12 s on Yandex 360 (cli-testing, performance/mail).
  requestMs: 9_000,
  contentLanguages: ["ru", "en"],
}

export const SKILL = new URL("../skills/mail-cli/SKILL.md", import.meta.url)
