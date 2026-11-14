import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { CliError } from "@wirecat/cli-base"
import { metaOf } from "@wirecat/cli-base/commands"
import { BASE_REASONS } from "@wirecat/cli-base/standards"
import { CORE_REASONS } from "@wirecat/cli-core"
import { afterEach, describe, expect, it, vi } from "vitest"
import { flagParser, inWords } from "./commands/words.js"
import { discover, domainOf, parseAutoconfig } from "./discovery.js"
import { openJournal } from "./export/journal.js"
import { mapImapError } from "./mail/imap/index.js"
import { flagOf } from "./mail/organise.js"
import { actionsOf } from "./mail/rules/query.js"
import { safeName } from "./mail/save.js"
import { writeProfile } from "./profile.js"
import { createProgram } from "./program.js"
import { REASONS } from "./reasons.js"
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
      fetch: async (url) => {
        urls.push(String(url))
        if (String(url).includes("thunderbird")) throw new Error("offline")
        return new Response(xml)
      },
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

describe("sync, messages import and messages export", () => {
  it("are cooperative, so the 30 s command default does not cut them and a stop keeps their work", () => {
    const program = createProgram()
    const sync = program.commands.find((command) => command.name() === "sync")
    const messages = program.commands.find((command) => command.name() === "messages")
    const importing = messages?.commands.find((command) => command.name() === "import")
    const exporting = messages?.commands.find((command) => command.name() === "export")
    expect(sync && metaOf(sync).cooperative).toBe(true)
    expect(importing && metaOf(importing).cooperative).toBe(true)
    expect(exporting && metaOf(exporting).cooperative).toBe(true)
  })
})

describe("safeName", () => {
  it("cleans a sender's file name as cli-core's downloads do, and falls back when nothing safe is left", () => {
    expect(safeName("../../notes.txt", "attachment-1")).toBe("notes.txt")
    expect(safeName("invoice\u202Efdp.exe", "attachment-1")).toBe("invoicefdp.exe")
    expect(safeName("zero\u200Bwidth.pdf", "attachment-1")).toBe("zerowidth.pdf")
    expect(safeName("..", "attachment-2")).toBe("attachment-2")
  })
})

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === "testing" ? [] : sourceFiles(path)
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : []
  })

describe("error reasons", () => {
  it("registers every reason the source raises, in mail's registry or a shared one", () => {
    const registered = new Set([...REASONS, ...CORE_REASONS, ...BASE_REASONS].map(({ reason }) => reason))
    const raised = sourceFiles(fileURLToPath(new URL(".", import.meta.url))).flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/reason: "([a-z][a-z0-9.-]*)"/g)].map(([, reason]) => `${reason}`),
    )
    expect(raised.length).toBeGreaterThan(20)
    expect([...new Set(raised)].filter((reason) => !registered.has(reason))).toEqual([])
  })
})

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

describe("the layers below the commands name no command", () => {
  const SRC = fileURLToPath(new URL(".", import.meta.url))
  // The identity, the reason registry, and a recorded command line read back.
  const ALLOWED = new Set(["program.ts", "store.ts", "reasons.ts", join("mail", "cleanup.ts")])

  it("keeps command lines and flags out of their strings", () => {
    const named = sourceFiles(SRC)
      .filter((file) => !/^(commands|bin)[\\/]/.test(file.slice(SRC.length)) && !ALLOWED.has(file.slice(SRC.length)))
      .flatMap((file) =>
        readFileSync(file, "utf8")
          .split("\n")
          .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
          .filter((line) => /IDENTITY\.command|["'`][^"'`]*--[a-z][a-z-]+/.test(line))
          .map((line) => `${file.slice(SRC.length)}: ${line.trim()}`),
      )
    expect(named).toEqual([])
  })

  it("words a lower layer's refusal with the command's flags", async () => {
    const words = (work: () => unknown) => {
      try {
        work()
      } catch (error) {
        return messageOf(inWords(error, "personal"))
      }
      throw new Error("nothing was refused")
    }
    expect(words(() => flagOf("deleted"))).toBe(
      "\\Deleted is how a server expunges mail; messages delete moves it to Trash",
    )
    expect(words(() => flagParser("--do", actionsOf)("bogus"))).toBe(
      "--do: choose skip, envelope, keep, protect, plus any tag:<name>",
    )
    const env = { MAIL_CONFIG_DIR: mkdtempSync(join(tmpdir(), "config-")) }
    writeProfile(env, "personal", {}, false)
    expect(words(() => writeProfile(env, "personal", {}, false))).toBe(
      "profile personal already exists; pass --replace to overwrite it",
    )
    const full = mkdtempSync(join(tmpdir(), "export-"))
    writeFileSync(join(full, "x"), "")
    const refused = await openJournal({ path: full, format: "mbox", account: "me@example.com", mode: "new" }).catch(
      (error: unknown) => messageOf(inWords(error, "personal")),
    )
    expect(refused).toBe(`${full} is not empty; --replace writes into it anyway, over files of the same name`)
    const unknown = await discover("x@nowhere.test", {
      mx: async () => [],
      fetch: async () => new Response("", { status: 404 }),
    }).catch((error: unknown) => messageOf(inWords(error, "personal")))
    expect(unknown).toMatch(/^no mail server found for nowhere\.test; pass --provider \(.+\), or --host, --port/)
    const late = new CliError("timeout", "the command reached its time limit", { reason: "command.timed-out" })
    expect(messageOf(inWords(late, "personal"))).toBe(
      "the command reached its time limit; run it again with a longer --timeout, such as --timeout 30m",
    )
  })
})
