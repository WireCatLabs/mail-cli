import type { ManifestIdentity } from "@wirecat/cli-base/wcat/manifest"
import type { AppIdentity } from "@wirecat/cli-core"
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
    "gmail.googleapis.com",
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
  // One port per WireCat tool, so two servers never collide (wirecat-desktop docs/dev/cli-registry.md).
  mcpPort: 8753,
  tagline: "Your mailbox over IMAP, searchable on your computer",
  syncs: "mail",
  syncSchedule: { every: "5m", choices: ["5m", "15m", "30m", "1h", "2h", "4h", "8h", "24h"], args: ["sync"] },
  signIn: {
    gives:
      "Lets your agent read and search your mail, and sort and send it as far as your settings allow. A Microsoft sign-in may not grant sending.",
    asks: "Your mail address and an app password, or a Microsoft or Google sign-in in the browser.",
    methods: [
      {
        id: "microsoft",
        label: "Microsoft",
        words: ["{profile}", "session", "start", "--json", "--answer-stdin"],
        address: "--address",
        clientId: "microsoft_client_id",
      },
      {
        id: "gmail",
        label: "Gmail",
        words: ["{profile}", "session", "start", "--json", "--answer-stdin"],
        address: "--address",
        clientFile: "--client-file",
        oauth: ["--method", "oauth"],
      },
      {
        id: "imap",
        label: "Another mail server",
        words: ["{profile}", "session", "start", "--json", "--answer-stdin"],
        address: "--address",
      },
    ],
  },
}

export const SKILL = new URL("../skills/mail-cli/SKILL.md", import.meta.url)
