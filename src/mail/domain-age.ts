import { readFileSync } from "node:fs"
import { join } from "node:path"
import { resolvePaths, writeSecurely } from "@wirecat/cli-base"
import { hostFetch } from "@wirecat/cli-base/http"
import { providerRequest } from "@wirecat/cli-core/cli"
import type { DomainAge } from "@wirecat/cli-core/mail"
import * as v from "valibot"
import { IDENTITY } from "../identity.js"

/** IANA's list of which registry answers RDAP for which top-level domain (RFC 9224). */
export const BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json"
const BOOTSTRAP_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const REQUEST_GAP_MS = 1000
const TIMEOUT_MS = 10_000
const USER_AGENT = `mail-cli/${IDENTITY.version} (+https://github.com/WireCatLabs/mail-cli)`

const SERVICES = v.array(v.tuple([v.array(v.string()), v.array(v.string())]))

const AGE_CACHE = v.object({
  bootstrap: v.optional(v.object({ fetchedAt: v.string(), services: SERVICES })),
  domains: v.optional(
    v.record(
      v.string(),
      v.object({ created: v.optional(v.string()), unsupported: v.optional(v.boolean()), checkedAt: v.string() }),
    ),
    {},
  ),
}) satisfies v.GenericSchema<unknown, { domains: Record<string, DomainAge> }>

type AgeCache = v.InferOutput<typeof AGE_CACHE>

const REGISTRY_ANSWER = v.object({
  events: v.optional(
    v.array(v.object({ eventAction: v.optional(v.unknown()), eventDate: v.optional(v.unknown()) })),
    [],
  ),
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const fileOf = (env: NodeJS.ProcessEnv) =>
  join(resolvePaths({ appName: IDENTITY.appName, prefix: IDENTITY.envPrefix, env }).state, "domain-ages.json")

// A registration date never changes, so the cache is kept on this computer for good and asked again never.
const loadCache = (env: NodeJS.ProcessEnv): AgeCache => {
  try {
    const parsed = v.safeParse(AGE_CACHE, JSON.parse(readFileSync(fileOf(env), "utf8")))
    return parsed.success ? parsed.output : { domains: {} }
  } catch {
    return { domains: {} }
  }
}

const saveCache = (env: NodeJS.ProcessEnv, cache: AgeCache): void => {
  writeSecurely(fileOf(env), JSON.stringify(cache), 0o600)
}

/** The ages already looked up; reads no network. */
export const knownAges = (env: NodeJS.ProcessEnv): Map<string, DomainAge> =>
  new Map(Object.entries(loadCache(env).domains))

export interface LookupDeps {
  fetch?: typeof fetch | undefined
  sleep: (ms: number) => Promise<void>
  now: () => Date
}

/** The real clock and pause, with the fetch a test hands in, else the network's. */
export const rdapDeps = (fetcher?: typeof fetch): LookupDeps => ({
  fetch: fetcher,
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  now: () => new Date(),
})

const realDeps = rdapDeps()

const ERROR_BODY_BYTES = 4096

/**
 * The registry's own `errorCode` from an RDAP error body (RFC 9083 §6), as `rdap.<code>`; never its title or
 * description. A body over 4 KB, or one that is not JSON, gives none. Reads a clone, so the body stays readable.
 */
export const rdapErrorName = async (response: Response): Promise<string | undefined> => {
  const reader = response.clone().body?.getReader()
  if (!reader) return undefined
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > ERROR_BODY_BYTES) return undefined
      chunks.push(value)
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    const errorCode = isRecord(parsed) ? parsed.errorCode : undefined
    return Number.isInteger(errorCode) ? `rdap.${errorCode}` : undefined
  } catch {
    return undefined
  } finally {
    reader.cancel().catch(() => {})
  }
}

const getJson = async (
  deps: LookupDeps,
  url: string,
  operation: "rdap.bootstrap" | "rdap.domain",
): Promise<{ status: number; body: unknown }> => {
  const answered = providerRequest(operation, undefined, {
    method: "GET",
    endpointTemplate: operation === "rdap.bootstrap" ? "/rdap/dns.json" : "/domain/:id",
    transport: "http",
    attempt: 1,
  })
  let response: Response
  try {
    // The registry's host comes from IANA's list, not from a list mail could keep: each lookup reaches that host only.
    const only = hostFetch({
      hosts: [new URL(url).hostname],
      timeoutMs: TIMEOUT_MS,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    })
    response = await only(url, {
      headers: { accept: "application/rdap+json, application/json", "user-agent": USER_AGENT },
    })
  } catch (error) {
    answered({ error })
    throw error
  }
  // A domain the registry does not know is an answer, not a failure.
  if (response.ok || response.status === 404) answered({ status: response.status })
  else {
    const providerError = await rdapErrorName(response)
    answered({ status: response.status, error: true, ...(providerError ? { providerError } : {}) })
  }
  return { status: response.status, body: response.ok ? await response.json() : undefined }
}

const registrationOf = (body: unknown): string | undefined => {
  const parsed = v.safeParse(REGISTRY_ANSWER, body)
  const date = parsed.success
    ? parsed.output.events.find((event) => event.eventAction === "registration")?.eventDate
    : undefined
  return typeof date === "string" ? date : undefined
}

export interface LookupResult {
  looked: number
  failed: number
}

/**
 * Asks each domain's own registry when it was registered, straight from IANA's list, never through a relay: each
 * question tells that registry, and only it, the domain's name. One question a second; answers are kept for good.
 * A domain whose registry has no RDAP (most country domains: .ru, .de, .es, .io) is marked unsupported, not guessed.
 * Stops before `until`, a time in ms.
 */
export const lookUpAges = async (
  env: NodeJS.ProcessEnv,
  domains: readonly string[],
  deps: LookupDeps = realDeps,
  until = Number.POSITIVE_INFINITY,
): Promise<LookupResult> => {
  const cache = loadCache(env)
  const wanted = [...new Set(domains.map((domain) => domain.toLowerCase()))].filter(
    (domain) => cache.domains[domain] === undefined,
  )
  if (wanted.length === 0) return { looked: 0, failed: 0 }
  const fetchedAt = cache.bootstrap?.fetchedAt
  if (fetchedAt === undefined || deps.now().getTime() - Date.parse(fetchedAt) > BOOTSTRAP_MAX_AGE_MS) {
    const { body } = await getJson(deps, BOOTSTRAP_URL, "rdap.bootstrap")
    const services = v.safeParse(v.object({ services: SERVICES }), body)
    if (!services.success) throw new Error("IANA's RDAP list did not answer")
    cache.bootstrap = { fetchedAt: deps.now().toISOString(), services: services.output.services }
  }
  const servers = new Map<string, string>()
  for (const [tlds, urls] of cache.bootstrap?.services ?? []) {
    const url = urls.find((candidate) => candidate.startsWith("https://")) ?? urls[0]
    if (url !== undefined) for (const tld of tlds) servers.set(tld.toLowerCase(), url.endsWith("/") ? url : `${url}/`)
  }
  let looked = 0
  let failed = 0
  for (const domain of wanted) {
    const server = servers.get(domain.slice(domain.lastIndexOf(".") + 1))
    const checkedAt = deps.now().toISOString()
    if (server === undefined) {
      cache.domains[domain] = { unsupported: true, checkedAt }
      continue
    }
    // A domain left out is asked on a later run; the run's deadline wins over a full answer.
    if (deps.now().getTime() + REQUEST_GAP_MS + TIMEOUT_MS > until) break
    if (looked > 0) await deps.sleep(REQUEST_GAP_MS)
    looked++
    try {
      const { status, body } = await getJson(deps, `${server}domain/${encodeURIComponent(domain)}`, "rdap.domain")
      // Not found is an answer worth keeping; anything else may work another day, so it is not kept.
      if (status === 404) cache.domains[domain] = { checkedAt }
      else if (status >= 200 && status < 300) {
        const created = registrationOf(body)
        cache.domains[domain] = { ...(created === undefined ? {} : { created }), checkedAt }
      } else failed++
    } catch {
      failed++
    }
    saveCache(env, cache)
  }
  saveCache(env, cache)
  return { looked, failed }
}
