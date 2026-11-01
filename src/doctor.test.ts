import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { changesCheck } from "./mail/doctor.js"
import { run } from "./program.js"

const DAY = 86_400_000
const NOW = Date.parse("2026-11-01T12:00:00Z")

const lines = (...all: object[]) => `${all.map((one) => JSON.stringify(one)).join("\n")}\n`

const folders = () => {
  const env = {
    ...process.env,
    MAIL_STATE_DIR: mkdtempSync(join(tmpdir(), "state-")),
    MEMO_STATE_DIR: mkdtempSync(join(tmpdir(), "memo-state-")),
    MAIL_CONFIG_DIR: mkdtempSync(join(tmpdir(), "config-")),
  }
  const mine = join(env.MAIL_STATE_DIR, "changes", "me@example.com")
  mkdirSync(mine, { recursive: true })
  const memo = join(env.MEMO_STATE_DIR, "mail-trash", "gmail")
  mkdirSync(memo, { recursive: true })
  const run = (id: string, at: number) => ({
    type: "run",
    id,
    account: "me@example.com",
    command: "mail ya messages delete --rules --yes",
    started_at: new Date(at).toISOString(),
  })
  const trash = { type: "step", step: 1, op: "trash", folder: "[Gmail]/All Mail", validity: "1", items: [] as object[] }
  writeFileSync(join(mine, "stopped.jsonl"), lines(run("stopped", NOW - DAY)))
  writeFileSync(
    join(mine, "expiring.jsonl"),
    lines(
      { ...run("expiring", NOW - 27 * DAY), restorable_until: new Date(NOW + 3 * DAY).toISOString() },
      {
        ...trash,
        items: [
          { id: "1", uid: 5 },
          { id: "2", uid: 6 },
        ],
      },
      { type: "done", step: 1, ids: ["1", "2"] },
      { type: "restore", at: new Date(NOW - DAY).toISOString(), ids: ["2"] },
      { type: "end", ended_at: new Date(NOW - 27 * DAY).toISOString() },
    ),
  )
  writeFileSync(
    join(mine, "fresh.jsonl"),
    lines(
      { ...run("fresh", NOW - DAY), restorable_until: new Date(NOW + 29 * DAY).toISOString() },
      { ...trash, items: [{ id: "3", uid: 7 }] },
      { type: "done", step: 1, ids: ["3"] },
      { type: "end", ended_at: new Date(NOW - DAY).toISOString() },
    ),
  )
  writeFileSync(
    join(memo, "memo-run.jsonl"),
    lines(
      { type: "run", id: "memo-run", account: "me@example.com", started_at: new Date(NOW - 26 * DAY).toISOString() },
      { type: "batch", batch: 1, moved: ["9"], not_moved: [] },
    ),
  )
  return env
}

describe("doctor's report on change runs", () => {
  it("names a run that stopped part way and Trash Gmail empties within five days, memo's runs too", () => {
    const { fields, notes } = changesCheck(folders(), NOW)
    expect(fields.changes.runs).toBe(4)
    expect(fields.changes.unfinished.map(({ id }) => id).sort()).toEqual(["memo-run", "stopped"])
    expect(fields.changes.expiring).toEqual([
      {
        id: "memo-run",
        account: "me@example.com",
        restorable_until: new Date(NOW + 4 * DAY).toISOString(),
        in_trash: 1,
      },
      {
        id: "expiring",
        account: "me@example.com",
        restorable_until: new Date(NOW + 3 * DAY).toISOString(),
        in_trash: 1,
      },
    ])
    expect(notes.join("\n")).toContain("messages restore --run expiring --yes")
    expect(notes.join("\n")).not.toContain("fresh")
  })

  it("is part of mail doctor, offline", async () => {
    const env = folders()
    const out: string[] = []
    const err: string[] = []
    const code = await run(["doctor", "--json"], {
      streams: { data: (text) => out.push(text), diagnostic: (text) => err.push(text) },
      tty: false,
      env,
    })
    expect(code).toBe(0)
    expect(JSON.parse(out.join("")).item.changes.unfinished).toHaveLength(2)
    expect(err.join("\n")).toContain("stopped before the end")
  })
})
