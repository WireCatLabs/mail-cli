import { CliError } from "@wirecat/cli-base"
import { afterEach, describe, expect, it, vi } from "vitest"
import { discover, domainOf, parseAutoconfig } from "./discovery.js"
import { mapImapError } from "./mail/imap.js"
import { parseMail } from "./mail/parse.js"
import { proposedName } from "./profile.js"
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

describe("parseMail", () => {
  it("reads HTML-only mail as text without scripts, comments or tags", async () => {
    const raw =
      "From: Ann <ann@example.com>\r\nTo: undisclosed:;, Bob <bob@example.com>\r\nSubject: =?UTF-8?B?0J/RgNC40LLQtdGC?=\r\n" +
      "Content-Type: text/html; charset=utf-8\r\nIn-Reply-To: <a@x>\r\nReferences: <a@x> <b@x>\r\n\r\n" +
      "<p>Hi&nbsp;&amp; bye</p><!-- hidden --><script>steal()</script><style>p{}</style>"
    const mail = await parseMail(Buffer.from(raw))
    expect(mail.subject).toBe("Привет")
    expect(mail.text).toContain("Hi & bye")
    expect(mail.text).not.toMatch(/steal|hidden|<p>/)
    expect(mail).toMatchObject({
      inReplyTo: "<a@x>",
      references: ["<a@x>", "<b@x>"],
      to: [{ address: "bob@example.com" }],
    })
  })
  it("survives mail with no body and no date", async () => {
    expect(await parseMail(Buffer.from("Subject: x\r\n\r\n"))).toMatchObject({ text: "", sentAt: null, from: null })
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

describe("profile names", () => {
  it("proposes the part before the @, cleaned", () => {
    expect(proposedName("Ya@burobiz.ru")).toBe("ya")
    expect(proposedName("+++@x.ru")).toBe("mail")
  })
})

describe("secretToolLookup", () => {
  it("answers nothing when secret-tool is not installed", async () => {
    vi.stubEnv("PATH", "/nonexistent")
    expect(await secretToolLookup("anything")).toBeUndefined()
  })
})
