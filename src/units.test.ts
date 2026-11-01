import { CliError } from "@wirecat/cli-base"
import { metaOf } from "@wirecat/cli-base/commands"
import { afterEach, describe, expect, it, vi } from "vitest"
import { discover, domainOf, parseAutoconfig } from "./discovery.js"
import { mapImapError } from "./mail/imap/index.js"
import { createProgram } from "./program.js"
import { secretToolLookup } from "./secret.js"

afterEach(() => vi.unstubAllEnvs())

describe("mapImapError", () => {
  const code = (error: unknown) => mapImapError(error).code
  it("keeps a CliError as it is", () => {
    const own = new CliError("not_found", "x")
    expect(mapImapError(own)).toBe(own)
  })
  it("maps what imapflow reports to the closed set of codes", () => {
    expect(code({ authenticationFailed: true })).toBe("authentication_error")
    expect(code({ code: "ETHROTTLE", throttleReset: 5000 })).toBe("rate_limited")
    expect(mapImapError({ code: "ETHROTTLE", throttleReset: 5000 }).details.retry_after_ms).toBe(5000)
    expect(code({ responseStatus: "NO", response: { attributes: [{ section: [{ value: "THROTTLED" }] }] } })).toBe(
      "rate_limited",
    )
    expect(code({ responseStatus: "NO", responseText: "Request is throttled" })).toBe("rate_limited")
    expect(code({ code: "ETIMEDOUT" })).toBe("timeout")
    expect(code({ code: "ECONNREFUSED" })).toBe("network_error")
    expect(code({ code: "ENOTFOUND" })).toBe("network_error")
    expect(code({ responseStatus: "BAD" })).toBe("provider_error")
  })
  it("never repeats the server's text", () => {
    expect(
      mapImapError({ responseStatus: "NO", responseText: "mailbox 'Secret client' not found" }).message,
    ).not.toContain("Secret")
  })
})

describe("discovery edges", () => {
  it("refuses a malformed address", () => {
    expect(() => domainOf("not an address")).toThrow(/full mail address/)
  })
  it("ignores an autoconfig file with no usable IMAP server", () => {
    expect(parseAutoconfig("<clientConfig></clientConfig>", "a@b.c")).toBeUndefined()
    expect(
      parseAutoconfig(
        '<incomingServer type="imap"><hostname>bad host</hostname><port>1</port></incomingServer>',
        "a@b.c",
      ),
    ).toBeUndefined()
  })
  it("falls back to the domain's own autoconfig file, and survives a network failure", async () => {
    const xml =
      '<incomingServer type="imap"><hostname>imap.own.test</hostname><port>993</port><socketType>SSL</socketType></incomingServer>'
    const urls: string[] = []
    const found = await discover("x@own.test", {
      mx: async () => {
        throw new Error("no dns")
      },
      fetch: (async (url: string) => {
        urls.push(url)
        if (url.includes("thunderbird")) throw new Error("offline")
        return new Response(xml)
      }) as unknown as typeof fetch,
    })
    expect(found).toMatchObject({ found_by: "autoconfig", login: "x@own.test", imap: { host: "imap.own.test" } })
    expect(urls[0]).toContain("autoconfig.thunderbird.net")
  })
})

describe("secretToolLookup", () => {
  it("answers nothing when secret-tool is not installed", async () => {
    vi.stubEnv("PATH", "/nonexistent")
    expect(await secretToolLookup("anything")).toBeUndefined()
  })
})

describe("sync", () => {
  it("is cooperative, so the 30 s command default does not cut a long sync", () => {
    const sync = createProgram().commands.find((command) => command.name() === "sync")
    expect(sync && metaOf(sync).cooperative).toBe(true)
  })
})
