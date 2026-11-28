import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it } from "vitest"
import { memoTrashFolder, resetMemoTrashWarning } from "./memo-trash.js"

const folders = () => {
  const root = mkdtempSync(join(tmpdir(), "memo-trash-"))
  return {
    env: { MEMO_STATE_DIR: join(root, "cli-memo"), WCAT_STATE_DIR: join(root, "wcat") },
    old: join(root, "cli-memo", "mail-trash"),
    current: join(root, "wcat", "mail-trash"),
  }
}

const run = (folder: string) => {
  mkdirSync(join(folder, "gmail"), { recursive: true })
  writeFileSync(join(folder, "gmail", "r1.jsonl"), '{"type":"run"}\n')
}

beforeEach(() => resetMemoTrashWarning())

describe("memo's mail-trash, now under wcat", () => {
  it("reads wcat's folder", () => {
    const { env, current } = folders()
    expect(memoTrashFolder(env)).toBe(current)
  })

  it("moves the folder from cli-memo when wcat has not started yet", () => {
    const { env, old, current } = folders()
    run(old)

    expect(memoTrashFolder(env)).toBe(current)
    expect(existsSync(old)).toBe(false)
    expect(readFileSync(join(current, "gmail", "r1.jsonl"), "utf8")).toBe('{"type":"run"}\n')
  })

  it("merges nothing when both folders exist, and warns once", () => {
    const { env, old, current } = folders()
    run(old)
    run(current)
    const warnings: string[] = []

    expect(memoTrashFolder(env, (line) => warnings.push(line))).toBe(current)
    memoTrashFolder(env, (line) => warnings.push(line))

    expect(existsSync(join(old, "gmail", "r1.jsonl"))).toBe(true)
    expect(warnings).toHaveLength(1)
  })
})
