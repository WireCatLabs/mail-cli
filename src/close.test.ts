import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ADDRESS, harness, OLD, raw } from "./testing/mailbox.js"

const folders = () => [
  {
    name: "INBOX",
    messages: [
      { uid: 1, raw: raw("lunch", "Lunch", "Noon?"), flags: [], date: OLD },
      { uid: 2, raw: raw("trip", "Trip plan", "Train at nine."), flags: [], date: OLD },
    ],
  },
  { name: "Sent", attributes: ["\\Sent"], messages: [] },
  { name: "Drafts", attributes: ["\\Drafts"], messages: [] },
  { name: "Trash", attributes: ["\\Trash"], messages: [] },
]

type Mailbox = Awaited<ReturnType<typeof harness>>

/** Whether the server had seen this command's LOGOUT when the answer's first line was written. */
const loggedOutFirst = async ({ mail, commands }: Mailbox, argv: string[]) => {
  const logouts = () => commands().filter((line) => line === "LOGOUT").length
  const before = logouts()
  let first: boolean | undefined
  const out: string[] = []
  const answer = await mail(["ya", ...argv, "--json"], {
    streams: {
      data: (text) => {
        first ??= logouts() > before
        out.push(text)
      },
      diagnostic: () => {},
    },
  })
  expect(answer.code, out.join("")).toBe(0)
  return first
}

describe("a command that talks to the server answers only after it logged out", () => {
  it.each([
    ["account", "check"],
    ["account", "inspect"],
    ["folders", "list"],
    ["folders", "create", "Receipts"],
    ["sync", "--since-time", "2026-01-01"],
    ["drafts", "list"],
    ["drafts", "create", "--to", ADDRESS, "--subject", "Note", "Remember"],
  ])("%s %s", async (...argv) => {
    expect(await loggedOutFirst(await harness({ folders: folders() }), argv)).toBe(true)
  })

  it("messages export", async () => {
    const output = join(mkdtempSync(join(tmpdir(), "export-")), "out")
    const mailbox = await harness({ folders: folders() })
    expect(await loggedOutFirst(mailbox, ["messages", "export", "--output", output])).toBe(true)
  })

  it("messages mark-read", async () => {
    const mailbox = await harness({ folders: folders() })
    const ref = await mailbox.refOf("Lunch")
    expect(await loggedOutFirst(mailbox, ["messages", "mark-read", ref])).toBe(true)
  })
})
