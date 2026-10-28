import { resolveMx } from "node:dns/promises"
import { CliError } from "@wirecat/cli-base"

export type Security = "tls" | "starttls"

export interface Endpoint {
  host: string
  port: number
  security: Security
}

export interface Discovery {
  address: string
  provider: string
  imap: Endpoint
  /** What the server wants as the login name. */
  login: string
  auth: "app-password" | "oauth"
  found_by: "built-in" | "mx" | "ispdb" | "autoconfig"
  note?: string
}

interface Known {
  provider: string
  imap: Endpoint
  auth: Discovery["auth"]
  note?: string
}

const tls = (host: string): Endpoint => ({ host, port: 993, security: "tls" })

const KNOWN: Record<string, Known> = {
  yandex: {
    provider: "Yandex",
    imap: tls("imap.yandex.com"),
    auth: "app-password",
    note: "turn on IMAP and app passwords in Yandex settings, then make a password of type Mail",
  },
  gmail: {
    provider: "Gmail",
    imap: tls("imap.gmail.com"),
    auth: "app-password",
    note: "needs 2-step verification and an app password; IMAP downloads are capped at 2500 MB a day",
  },
  icloud: {
    provider: "iCloud",
    imap: tls("imap.mail.me.com"),
    auth: "app-password",
    note: "needs an app-specific password",
  },
  mailru: {
    provider: "Mail.ru",
    imap: tls("imap.mail.ru"),
    auth: "app-password",
    note: "needs an app password for external programs",
  },
  fastmail: { provider: "Fastmail", imap: tls("imap.fastmail.com"), auth: "app-password" },
  outlook: {
    provider: "Outlook",
    imap: tls("outlook.office365.com"),
    auth: "oauth",
    note: "Microsoft accepts only OAuth for IMAP; an app password cannot work, wait for OAuth sign-in",
  },
}

const BY_DOMAIN: Record<string, keyof typeof KNOWN> = {
  "yandex.ru": "yandex",
  "yandex.com": "yandex",
  "ya.ru": "yandex",
  "yandex.by": "yandex",
  "yandex.kz": "yandex",
  "yandex.ua": "yandex",
  "gmail.com": "gmail",
  "googlemail.com": "gmail",
  "icloud.com": "icloud",
  "me.com": "icloud",
  "mac.com": "icloud",
  "mail.ru": "mailru",
  "inbox.ru": "mailru",
  "list.ru": "mailru",
  "bk.ru": "mailru",
  "internet.ru": "mailru",
  "fastmail.com": "fastmail",
  "fastmail.fm": "fastmail",
  "outlook.com": "outlook",
  "hotmail.com": "outlook",
  "live.com": "outlook",
}

// A domain with its own name can still be hosted at one of these: its MX record says where.
const BY_MX: [RegExp, keyof typeof KNOWN][] = [
  [/(^|\.)mx\.yandex\.(net|ru)$|(^|\.)yandex\.(net|ru)$/, "yandex"],
  [/(^|\.)(aspmx\.l\.google\.com|googlemail\.com|google\.com)$/, "gmail"],
  [/\.mail\.protection\.outlook\.com$/, "outlook"],
  [/(^|\.)messagingengine\.com$/, "fastmail"],
  [/(^|\.)mail\.ru$/, "mailru"],
]

export const ADDRESS = /^[^\s@<>()[\]\\,;:"]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)$/

export const domainOf = (address: string): string => {
  const match = ADDRESS.exec(address.trim())
  if (!match)
    throw new CliError("validation_error", "give a full mail address, such as name@example.com", { param: "address" })
  return (match[1] as string).toLowerCase()
}

const found = (address: string, key: keyof typeof KNOWN, found_by: Discovery["found_by"]): Discovery => {
  const known = KNOWN[key] as Known
  return {
    address,
    provider: known.provider,
    imap: known.imap,
    // Every provider in the table logs in with the full address.
    login: address,
    auth: known.auth,
    found_by,
    ...(known.note ? { note: known.note } : {}),
  }
}

export interface DiscoveryDeps {
  fetch?: typeof fetch
  mx?: (domain: string) => Promise<string[]>
  signal?: AbortSignal
}

const defaultMx = async (domain: string): Promise<string[]> =>
  (await resolveMx(domain)).map((record) => record.exchange)

const attribute = (block: string, name: string): string | undefined =>
  new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`, "i").exec(block)?.[1]

/** The first IMAP server of a Mozilla autoconfig file; one that offers no encryption is ignored. */
export const parseAutoconfig = (
  xml: string,
  address: string,
): Omit<Discovery, "found_by" | "provider" | "auth"> | undefined => {
  const servers = [...xml.matchAll(/<incomingServer\s+type="imap"[^>]*>([\s\S]*?)<\/incomingServer>/gi)]
  for (const [, block = ""] of servers) {
    const host = attribute(block, "hostname")
    const port = Number(attribute(block, "port"))
    const socket = attribute(block, "socketType")?.toUpperCase()
    if (!host || !Number.isInteger(port) || !/^[A-Za-z0-9.-]+$/.test(host)) continue
    const security: Security | undefined = socket === "SSL" ? "tls" : socket === "STARTTLS" ? "starttls" : undefined
    if (!security) continue
    const user = attribute(block, "username") ?? "%EMAILADDRESS%"
    const local = address.split("@")[0] as string
    const login = user.replace("%EMAILADDRESS%", address).replace("%EMAILLOCALPART%", local)
    return { address, imap: { host, port, security }, login }
  }
  return undefined
}

const ask = async (url: string, deps: DiscoveryDeps): Promise<string | undefined> => {
  try {
    const response = await (deps.fetch ?? fetch)(url, {
      signal: AbortSignal.any([AbortSignal.timeout(8000), ...(deps.signal ? [deps.signal] : [])]),
    })
    return response.ok ? await response.text() : undefined
  } catch {
    return undefined
  }
}

/**
 * Built-in table by domain, then the MX record, then Thunderbird's ISPDB, then the domain's own autoconfig file.
 * The result is only a proposal: `setup` shows it and the owner confirms.
 */
export const discover = async (input: string, deps: DiscoveryDeps = {}): Promise<Discovery> => {
  const address = input.trim().toLowerCase()
  const domain = domainOf(address)
  const key = BY_DOMAIN[domain]
  if (key) return found(address, key, "built-in")

  try {
    const exchanges = await (deps.mx ?? defaultMx)(domain)
    for (const [pattern, name] of BY_MX)
      if (exchanges.some((host) => pattern.test(host.toLowerCase()))) return found(address, name, "mx")
  } catch {
    // No MX record, or no network: the file lookups below may still answer.
  }

  const sources: [string, Discovery["found_by"]][] = [
    [`https://autoconfig.thunderbird.net/v1.1/${encodeURIComponent(domain)}`, "ispdb"],
    [`https://autoconfig.${domain}/mail/config-v1.1.xml`, "autoconfig"],
  ]
  for (const [url, found_by] of sources) {
    const xml = await ask(url, deps)
    const parsed = xml ? parseAutoconfig(xml, address) : undefined
    if (parsed) return { ...parsed, provider: domain, auth: "app-password", found_by }
  }
  throw new CliError("not_found", `no mail server found for ${domain}; pass --host, --port and --security yourself`, {
    param: "address",
  })
}
