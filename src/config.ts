import { commandPermissions, type Settings, settingsFor } from "@wirecat/cli-core/cli"
import * as v from "valibot"
import { IDENTITY } from "./identity.js"

const PROFILE_ENTRIES = {
  address: v.optional(v.string()),
  login: v.optional(v.string()),
  imap_host: v.optional(v.string()),
  imap_port: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535))),
  imap_security: v.optional(v.picklist(["tls", "starttls"])),
  folders: v.optional(v.array(v.string())),
}

export interface Mailbox {
  address?: string
  login?: string
  host?: string
  port?: number
  security?: "tls" | "starttls"
  folders?: string[]
}

export const configuration = settingsFor<{ mailbox: Mailbox }>(IDENTITY, {
  permissions: commandPermissions(),
  profile: PROFILE_ENTRIES,
  resolve: ({ fromLayers }) => {
    const pick = <T>(key: string) => fromLayers<T | undefined>(key, undefined)
    const address = pick<string>("address")
    const login = pick<string>("login")
    const host = pick<string>("imap_host")
    const port = pick<number>("imap_port")
    const security = pick<"tls" | "starttls">("imap_security")
    const folders = pick<string[]>("folders")
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
        },
      },
      sources: {
        address: address.from,
        login: login.from,
        imap_host: host.from,
        imap_port: port.from,
        imap_security: security.from,
        folders: folders.from,
      },
    }
  },
})

export type MailSettings = Settings & { mailbox: Mailbox }
