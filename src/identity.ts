import type { ManifestIdentity } from "@wirecat/cli-base/wcat/manifest"
import type { AppIdentity } from "@wirecat/cli-core/cli"
import { REASONS } from "./reasons.js"
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
  sends: true,
  // One call to the source reads 60 messages on 4 connections: 5 to 12 s on Yandex 360 (cli-testing, performance/mail).
  requestMs: 9_000,
  contentLanguages: ["ru", "en"],
  errors: { reasons: REASONS },
}

// The bin hands this to wcatStart before the program loads, so it must not import the command tree; src/wcat.ts adds
// the permission keys for the manifest.
export const DESKTOP: ManifestIdentity = {
  ...IDENTITY,
  docs: "https://github.com/WireCatLabs/mail-cli#readme",
  hosts: [
    "login.microsoftonline.com",
    "accounts.google.com",
    "oauth2.googleapis.com",
    "openidconnect.googleapis.com",
    "autoconfig.thunderbird.net",
    "data.iana.org",
    "imap.yandex.com",
    "smtp.yandex.ru",
    "imap.gmail.com",
    "smtp.gmail.com",
    "imap.mail.me.com",
    "smtp.mail.me.com",
    "imap.mail.ru",
    "smtp.mail.ru",
    "imap.fastmail.com",
    "smtp.fastmail.com",
    "outlook.office365.com",
    "smtp.office365.com",
    "smtp-mail.outlook.com",
  ],
  userHosts:
    "the mail server you sign in to, your domain's autoconfig file, and each sender domain's registry from IANA's list",
  tagline: "Your mailbox over IMAP, searchable on your computer",
  syncs: "mail from the folders you choose",
  signIn: {
    gives: "Lets your agent read, organise and send your mail.",
    asks: "Your mail address and an app password, or a Microsoft or Google sign-in in the browser.",
  },
}

export const SKILL = new URL("../skills/mail-cli/SKILL.md", import.meta.url)
