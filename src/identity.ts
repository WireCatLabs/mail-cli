import type { AppIdentity } from "@wirecat/cli-core/cli"
import { VERSION } from "./version.js"

export const PACKAGE = "@wirecat/mail-cli"

export const IDENTITY: AppIdentity = {
  command: "mail",
  appName: "mail-cli",
  envPrefix: "MAIL",
  description: "read mail over IMAP into the shared store, with app passwords kept in the OS keyring",
  version: VERSION,
  issues: "https://github.com/WireCatLabs/mail-cli/issues/new",
  messenger: false,
  contentLanguages: ["ru", "en"],
}

export const SKILL = new URL("../skills/mail-cli/SKILL.md", import.meta.url)
