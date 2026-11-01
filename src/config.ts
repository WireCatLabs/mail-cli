import { commandPermissions, type Settings, settingsFor } from "@wirecat/cli-core/cli"
import * as v from "valibot"
import { IDENTITY } from "./identity.js"

/** Checked beside `messages.send` and `messages.forward` when the mail reaches anyone but the owner. */
export const SEND_OTHERS_KEY = "messages.send.others"

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
  folders: v.optional(v.array(v.string())),
}

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
  folders?: string[]
}

export const configuration = settingsFor<{ mailbox: Mailbox }>(IDENTITY, {
  // An ordinary change goes ahead, as tg's and drive's do; a deletion or a change of many asks (WC-PERM-22, NEED-2067 A).
  // Mail to anyone but the owner asks, and the owner may allow it (NEED-1898); WC-PERM-22 would make it deny.
  permissions: commandPermissions({
    extra: ["messages.bulk", SEND_OTHERS_KEY],
    defaults: {
      "messages.delete": "ask",
      "folders.delete": "ask",
      "messages.bulk": "ask",
      [SEND_OTHERS_KEY]: "ask",
    },
  }),
  profile: PROFILE_ENTRIES,
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
    const defined = <T>(key: string, value: T | undefined) => (value === undefined ? {} : { [key]: value })
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
        },
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
      },
    }
  },
})

export type MailSettings = Settings & { mailbox: Mailbox }
