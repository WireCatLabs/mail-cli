import {
  commandPermissions,
  SCHEDULE_SETTINGS,
  type ScheduleLimits,
  type Settings,
  scheduleLimitsOf,
  settingsFor,
} from "@wirecat/cli-core"
import * as v from "valibot"
import { IDENTITY } from "./identity.js"

/** Checked beside `messages.send` and `messages.forward` when the mail reaches anyone but the owner. */
export const SEND_OTHERS_KEY = "messages.send.others"

/** Where the app password goes, which app signs in, and who an agent may mail: an agent holding `mcp.authority` changes neither. */
export const OWNER_ONLY = {
  settings: [
    "address",
    "login",
    "imap_host",
    "imap_port",
    "imap_security",
    "smtp_host",
    "smtp_port",
    "smtp_security",
    "auth",
    "google_client_id",
    "microsoft_client_id",
    "aliases",
  ],
  permissions: [SEND_OTHERS_KEY],
}

const ALIAS = v.pipe(v.string(), v.trim(), v.email())

const PROFILE_ENTRIES = {
  address: v.optional(v.string()),
  login: v.optional(v.string()),
  imap_host: v.optional(v.string()),
  imap_port: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535))),
  imap_security: v.optional(v.picklist(["tls", "starttls"])),
  smtp_host: v.optional(v.string()),
  smtp_port: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535))),
  smtp_security: v.optional(v.picklist(["tls", "starttls"])),
  auth: v.optional(v.picklist(["app-password", "oauth"])),
  google_client_id: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
  microsoft_client_id: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
  folders: v.optional(v.array(v.string())),
  // `config set aliases one@example.com` stores one address as a string: only `a,b` becomes a list.
  aliases: v.optional(v.union([ALIAS, v.array(ALIAS)])),
  read_attachments: v.optional(v.boolean()),
  max_attachment_mb: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  sync_since: v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.check(
        (value) =>
          SYNC_WINDOW.test(value) ||
          (/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(value) && Date.parse(value.slice(0, 10)) <= Date.now()),
        "has to be a window such as 30d, 12w or 1y, or a date in the past such as 2026-01-01",
      ),
    ),
  ),
}

/** How far back `sync` reads when the run gives no `--since-time`: days, weeks or years back from now. */
export const SYNC_WINDOW = /^([1-9]\d*)(d|w|y)$/
export const DEFAULT_SYNC_SINCE = "30d"

/** On, up to 10 MB a file, as cli-core's `DEFAULT_ATTACHMENT_POLICY`. */
export const DEFAULT_MAX_ATTACHMENT_MB = 10

export interface Mailbox {
  address?: string
  login?: string
  host?: string
  port?: number
  security?: "tls" | "starttls"
  /** The submission server, for a mailbox whose provider the registry does not know. */
  smtp?: { host?: string; port?: number; security?: "tls" | "starttls" }
  /** How the profile signs in; a profile saved before this key existed uses an app password. */
  auth: "app-password" | "oauth"
  /** The owner's own Google app, in place of WireCat's; its secret comes from `MAIL_GOOGLE_CLIENT_SECRET`. */
  googleClientId?: string
  /** The owner's own Microsoft app, in place of WireCat's, for every OAuth sign-in after it is set. */
  microsoftClientId?: string
  folders?: string[]
  /** The owner's other addresses on this mailbox: mail from one is the owner's, mail to one is addressed to them. */
  aliases?: string[]
  /** Whether sync reads attachments into the search index, and the largest file it reads; no file is kept. */
  attachments: { read: boolean; maxMb: number }
  /** `sync_since`: a window such as `30d`, or a date, read when a sync gives no `--since-time`. */
  syncSince: string
}

/** mail mounts `schedule agent` without `--on-new-mail`, so only the settings every agent schedule reads. */
const AGENT_SCHEDULE_SETTINGS = SCHEDULE_SETTINGS.filter(({ key }) => !key.startsWith("schedule_mail_"))

// An ordinary change goes ahead, as tg's and drive's do; a deletion or a change of many asks (WC-PERM-22, NEED-2067 A).
// Mail to anyone but the owner asks, and the owner may allow it (NEED-1898); WC-PERM-22 would make it deny.
export const permissions = commandPermissions({
  extra: ["messages.bulk", "messages.server-search", SEND_OTHERS_KEY],
  defaults: {
    "messages.delete": "ask",
    "folders.delete": "ask",
    "messages.bulk": "ask",
    "drafts.delete": "ask",
    [SEND_OTHERS_KEY]: "ask",
  },
})

export const configuration = settingsFor<{ mailbox: Mailbox; schedule: ScheduleLimits }>(IDENTITY, {
  permissions,
  profile: PROFILE_ENTRIES,
  defaults: {
    schedule_max_cost_per_day: v.optional(v.pipe(v.number(), v.minValue(0))),
    schedule_model_claude: v.optional(v.string()),
    schedule_model_codex: v.optional(v.string()),
    schedule_lean_start: v.optional(v.boolean()),
  },
  settings: [
    ...AGENT_SCHEDULE_SETTINGS,
    {
      key: "sync_since",
      default: DEFAULT_SYNC_SINCE,
      description: "how far back sync reads when a run names no start: 30d, 12w, 1y or a date",
    },
  ],
  resolve: ({ fromLayers }) => {
    const pick = <T>(key: string) => fromLayers<T | undefined>(key, undefined)
    const address = pick<string>("address")
    const login = pick<string>("login")
    const host = pick<string>("imap_host")
    const port = pick<number>("imap_port")
    const security = pick<"tls" | "starttls">("imap_security")
    const folders = pick<string[]>("folders")
    const aliases = pick<string | string[]>("aliases")
    const smtpHost = pick<string>("smtp_host")
    const smtpPort = pick<number>("smtp_port")
    const smtpSecurity = pick<"tls" | "starttls">("smtp_security")
    const auth = pick<Mailbox["auth"]>("auth")
    const googleClientId = pick<string>("google_client_id")
    const microsoftClientId = pick<string>("microsoft_client_id")
    const readAttachments = pick<boolean>("read_attachments")
    const maxAttachmentMb = pick<number>("max_attachment_mb")
    const syncSince = pick<string>("sync_since")
    const defined = <T>(key: string, value: T | undefined) => (value === undefined ? {} : { [key]: value })
    const schedule = AGENT_SCHEDULE_SETTINGS.map(({ key }) => [key, pick<unknown>(key)] as const)
    return {
      values: {
        mailbox: {
          ...defined("address", address.value),
          ...defined("login", login.value),
          ...defined("host", host.value),
          ...defined("port", port.value),
          ...defined("security", security.value),
          ...defined("folders", folders.value),
          ...defined("aliases", aliases.value === undefined ? undefined : [aliases.value].flat()),
          ...(smtpHost.value === undefined && smtpPort.value === undefined && smtpSecurity.value === undefined
            ? {}
            : {
                smtp: {
                  ...defined("host", smtpHost.value),
                  ...defined("port", smtpPort.value),
                  ...defined("security", smtpSecurity.value),
                },
              }),
          auth: auth.value ?? "app-password",
          ...defined("googleClientId", googleClientId.value),
          ...defined("microsoftClientId", microsoftClientId.value),
          attachments: {
            read: readAttachments.value ?? true,
            maxMb: maxAttachmentMb.value ?? DEFAULT_MAX_ATTACHMENT_MB,
          },
          syncSince: syncSince.value ?? DEFAULT_SYNC_SINCE,
        },
        schedule: scheduleLimitsOf(Object.fromEntries(schedule.map(([key, one]) => [key, one.value]))),
      },
      sources: {
        address: address.from,
        login: login.from,
        imap_host: host.from,
        imap_port: port.from,
        imap_security: security.from,
        folders: folders.from,
        aliases: aliases.from,
        smtp_host: smtpHost.from,
        smtp_port: smtpPort.from,
        smtp_security: smtpSecurity.from,
        auth: auth.from,
        google_client_id: googleClientId.from,
        microsoft_client_id: microsoftClientId.from,
        read_attachments: readAttachments.from,
        max_attachment_mb: maxAttachmentMb.from,
        sync_since: syncSince.from,
        ...Object.fromEntries(schedule.map(([key, one]) => [key, one.from])),
      },
    }
  },
})

export type MailSettings = Settings & { mailbox: Mailbox; schedule: ScheduleLimits }
