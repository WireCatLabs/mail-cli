import { resolveMx } from "node:dns/promises"
import { CliError } from "@wirecat/cli-base"
import {
  type Endpoint,
  GENERIC_PREPARE,
  PROVIDER_KEYS,
  PROVIDERS,
  type Prepare,
  type Provider,
  type ProviderKey,
  providerByDomain,
  type Security,
} from "./providers.js"

export interface Discovery {
  address: string
  provider: string
  imap: Endpoint
  /** What the server wants as the login name. */
  login: string
  auth: Provider["auth"]
  found_by: "built-in" | "mx" | "ispdb" | "autoconfig"
  note?: string
  prepare: Prepare
}

export const ADDRESS = /^[^\s@<>()[\]\\,;:"]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)$/

export const domainOf = (address: string): string => {
  const domain = ADDRESS.exec(address.trim())?.[1]
  if (!domain)
    throw new CliError("validation_error", "give a full mail address, such as name@example.com", { param: "address" })
  return domain.toLowerCase()
}

const found = (address: string, key: ProviderKey, found_by: Discovery["found_by"]): Discovery => {
  const provider = PROVIDERS[key]
  return {
    address,
    provider: provider.name,
    imap: provider.imap,
    login: address,
    auth: provider.auth,
    found_by,
    ...(provider.note ? { note: provider.note } : {}),
    prepare: provider.prepare,
  }
}

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "")

/** The names `--provider` and the interactive choice accept, in table order. */
export const PROVIDER_NAMES: string[] = PROVIDER_KEYS.map((key) => PROVIDERS[key].name)

/** A built-in provider picked by name, for an address whose own domain says nothing about its host. */
export const discoverByName = (input: string, name: string): Discovery => {
  const address = input.trim().toLowerCase()
  domainOf(address)
  const key = PROVIDER_KEYS.find(
    (candidate) => slug(candidate) === slug(name) || slug(PROVIDERS[candidate].name) === slug(name),
  )
  if (!key)
    throw new CliError("validation_error", `unknown provider ${name}; choose one of ${PROVIDER_NAMES.join(", ")}`, {
      param: "provider",
    })
  return found(address, key, "built-in")
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
): Omit<Discovery, "found_by" | "provider" | "auth" | "prepare"> | undefined => {
  const servers = [...xml.matchAll(/<incomingServer\s+type="imap"[^>]*>([\s\S]*?)<\/incomingServer>/gi)]
  for (const [, block = ""] of servers) {
    const host = attribute(block, "hostname")
    const port = Number(attribute(block, "port"))
    const socket = attribute(block, "socketType")?.toUpperCase()
    if (!host || !Number.isInteger(port) || !/^[A-Za-z0-9.-]+$/.test(host)) continue
    const security: Security | undefined = socket === "SSL" ? "tls" : socket === "STARTTLS" ? "starttls" : undefined
    if (!security) continue
    const user = attribute(block, "username") ?? "%EMAILADDRESS%"
    const local = address.split("@")[0] ?? ""
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
 * The built-in providers by domain, then the MX record, then Thunderbird's ISPDB, then the domain's own autoconfig
 * file. `session start` prints what it found and sends the password there only to check it.
 */
export const discover = async (input: string, deps: DiscoveryDeps = {}): Promise<Discovery> => {
  const address = input.trim().toLowerCase()
  const domain = domainOf(address)
  const key = providerByDomain(domain)
  if (key) return found(address, key, "built-in")

  try {
    const exchanges = (await (deps.mx ?? defaultMx)(domain)).map((host) => host.toLowerCase())
    const hosted = PROVIDER_KEYS.find((name) => {
      const pattern = PROVIDERS[name].mx
      return pattern !== undefined && exchanges.some((host) => pattern.test(host))
    })
    if (hosted) return found(address, hosted, "mx")
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
    if (parsed) return { ...parsed, provider: domain, auth: "app-password", found_by, prepare: GENERIC_PREPARE }
  }
  throw new CliError(
    "not_found",
    `no mail server found for ${domain}; pass --provider (${PROVIDER_NAMES.join(", ")}), or --host, --port and --security yourself`,
    {
      param: "address",
    },
  )
}
