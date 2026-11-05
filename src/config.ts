import {
  commandPermissions,
  SCHEDULE_SETTINGS,
  type ScheduleLimits,
  type Settings,
  scheduleLimitsOf,
  settingsFor,
} from "@wirecat/cli-core/cli"
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
  ],
  permissions: [SEND_OTHERS_KEY],
}

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
  read_attachments: v.optional(v.boolean()),
  max_attachment_mb: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
}

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
  /** Whether sync reads attachments into the search index, and the largest file it reads; no file is kept. */
  attachments: { read: boolean; maxMb: number }
}

/** mail mounts `schedule agent` without `--on-new-mail`, so only the settings every agent schedule reads. */
const AGENT_SCHEDULE_SETTINGS = SCHEDULE_SETTINGS.filter(({ key }) => !key.startsWith("schedule_mail_"))

export const configuration = settingsFor<{ mailbox: Mailbox; schedule: ScheduleLimits }>(IDENTITY, {
  // An ordinary change goes ahead, as tg's and drive's do; a deletion or a change of many asks (WC-PERM-22, NEED-2067 A).
  // Mail to anyone but the owner asks, and the owner may allow it (NEED-1898); WC-PERM-22 would make it deny.
  permissions: commandPermissions({
    extra: ["messages.bulk", "messages.server-search", SEND_OTHERS_KEY],
    defaults: {
      "messages.delete": "ask",
      "folders.delete": "ask",
      "messages.bulk": "ask",
      "drafts.delete": "ask",
      [SEND_OTHERS_KEY]: "ask",
    },
  }),
  profile: PROFILE_ENTRIES,
  defaults: {
    schedule_max_cost_per_day: v.optional(v.pipe(v.number(), v.minValue(0))),
    schedule_model_claude: v.optional(v.string()),
    schedule_model_codex: v.optional(v.string()),
    schedule_lean_start: v.optional(v.boolean()),
  },
  settings: AGENT_SCHEDULE_SETTINGS,
  resolve: ({ fromLayers }) => {
    const pick = <T>(key: string) => fromLayers<T | undefined>(key, undefined)
    const address = pick<string>("address")
    const login = pick<string>("login")
    const host = pick<string>("imap_host")
    const port = pick<number>("imap_port")
    const security = pick<"tls" | "starttls">("imap_security")
    const folders = pick<string[]>("folders")
    const smtpHost = pick<string>("smtp_host")
    const smtpPort = pick<number>("smtp_port")
    const smtpSecurity = pick<"tls" | "starttls">("smtp_security")
    const auth = pick<Mailbox["auth"]>("auth")
    const googleClientId = pick<string>("google_client_id")
    const microsoftClientId = pick<string>("microsoft_client_id")
    const readAttachments = pick<boolean>("read_attachments")
    const maxAttachmentMb = pick<number>("max_attachment_mb")
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
        smtp_host: smtpHost.from,
        smtp_port: smtpPort.from,
        smtp_security: smtpSecurity.from,
        auth: auth.from,
        google_client_id: googleClientId.from,
        microsoft_client_id: microsoftClientId.from,
        read_attachments: readAttachments.from,
        max_attachment_mb: maxAttachmentMb.from,
        ...Object.fromEntries(schedule.map(([key, one]) => [key, one.from])),
      },
    }
  },
})

export type MailSettings = Settings & { mailbox: Mailbox; schedule: ScheduleLimits }
