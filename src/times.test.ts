import { afterEach, beforeEach, expect, it } from "vitest"
import { harness, OLD, raw } from "./testing/mailbox.js"

const ZONE = "America/Los_Angeles"
const before = process.env.TZ
beforeEach(() => {
  process.env.TZ = ZONE
})
afterEach(() => {
  process.env.TZ = before
})

const folders = () => [
  { name: "INBOX", messages: [{ uid: 1, raw: raw("lunch", "Lunch", "Noon?"), flags: [], date: OLD }] },
  { name: "Sent", attributes: ["\\Sent"], messages: [] },
]

it("shows a person the times in the zone in use, without an offset, and keeps UTC in JSON", async () => {
  const { mail } = await harness({ folders: folders() })
  const shown = await mail(["ya", "status"], { tty: true })
  expect(shown.code, shown.err).toBe(0)
  expect(shown.out).toContain("2026-01-01 00:00")
  expect(shown.out).not.toMatch(/\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})/)
  expect(shown.err).toContain(`times in ${ZONE}`)

  const json = JSON.parse((await mail(["ya", "status", "--json"])).out)
  expect(json.item.folders[0].since).toBe("2026-01-01T08:00:00.000Z")
  expect(json.item.updated_at).toMatch(/Z$/)
})

it("shows the screens cli-core draws in the zone in use too, each with the line naming it", async () => {
  const { mail, refOf } = await harness({ folders: folders() })
  const ref = await refOf("lunch")
  const thread = JSON.parse((await mail(["ya", "conversations", "list", "--json"])).out).items[0].ref
  for (const argv of [
    ["search", "messages", "lunch"],
    ["messages", "show", ref],
    ["conversations", "list"],
    ["conversations", "show", thread],
    ["review", "date>2026-08-01"],
    ["runs", "list"],
  ]) {
    const shown = await mail(["ya", ...argv], { tty: true })
    expect(shown.code, shown.err).toBe(0)
    expect(shown.out, argv.join(" ")).not.toMatch(/\d{2}:\d{2}:\d{2}(\.\d+)?Z/)
    expect(shown.err, argv.join(" ")).toContain(`times in ${ZONE}`)
  }
  expect((await mail(["ya", "search", "messages", "lunch"], { tty: true })).out).toContain("2026-09-01 03:00")
})
