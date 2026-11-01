import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { CliError, resolvePaths } from "@wirecat/cli-base"

/** What one step did to the mailbox; its inverse is what `messages restore` does. */
export type ChangeOp = "flag" | "label" | "move" | "copy" | "trash"

export interface ChangedItem {
  /** The stored email's id: Gmail's X-GM-MSGID, or the hash of its Message-ID. */
  id: string
  uid: number
  /** Of the flags or labels this step changes, the ones the message had before it. */
  had?: string[]
  /** On Gmail, every label the message had before it went to Trash, so a restore puts them back. */
  labels?: string[]
  /** The Message-ID, to find the message again where the server gives no new UID. */
  mid?: string
}

/** Written before the server is asked: a step the server made without answering is still undone. */
export interface StepLine {
  type: "step"
  step: number
  op: ChangeOp
  folder: string
  validity: string
  to?: string
  change?: { add?: string[]; remove?: string[] }
  items: ChangedItem[]
}

export interface DoneLine {
  type: "done"
  step: number
  ids: string[]
  /** The UIDs the moved or copied messages have in `to`, by id, where the server said. */
  uids?: Record<string, number>
  to_validity?: string
}

export interface RunLine {
  type: "run"
  id: string
  account: string
  command: string
  started_at: string
  /** Gmail empties Trash after 30 days; a run that trashed mail there can be undone until then. */
  restorable_until?: string
}

export interface RestoreLine {
  type: "restore"
  at: string
  ids: string[]
}

type Line = RunLine | StepLine | DoneLine | RestoreLine | { type: "end"; ended_at: string }

export interface ChangeRun {
  run: RunLine
  steps: { step: StepLine; done?: DoneLine }[]
  restored: Set<string>
}

const RUN_ID = /^[\w.:-]+$/

const runsDir = (env: NodeJS.ProcessEnv, account: string) =>
  join(resolvePaths({ appName: "mail-cli", prefix: "MAIL", env }).state, "changes", account.toLowerCase())

const readLines = (path: string): Line[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((text) => {
      try {
        return [JSON.parse(text) as Line]
      } catch {
        // A torn last line from a run that died; the lines before it still say what happened.
        return []
      }
    })

/** One command's record of what it changed, appended as it goes; the file is the owner's only. */
export class ChangeLog {
  readonly path: string
  private step = 0

  constructor(
    env: NodeJS.ProcessEnv,
    readonly run: RunLine,
  ) {
    const dir = runsDir(env, run.account)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.path = join(dir, `${run.id.replace(/[^\w.-]/g, "_")}.jsonl`)
    this.write(run)
  }

  private write(line: Line) {
    appendFileSync(this.path, `${JSON.stringify(line)}\n`, { mode: 0o600 })
  }

  begin(step: Omit<StepLine, "type" | "step">): number {
    this.step++
    this.write({ type: "step", step: this.step, ...step })
    return this.step
  }

  done(step: number, ids: string[], moved?: { uids: Map<string, number>; validity?: string }) {
    this.write({
      type: "done",
      step,
      ids,
      ...(moved?.uids.size ? { uids: Object.fromEntries(moved.uids) } : {}),
      ...(moved?.validity ? { to_validity: moved.validity } : {}),
    })
  }

  end(at: number) {
    this.write({ type: "end", ended_at: new Date(at).toISOString() })
  }
}

export const appendRestore = (path: string, ids: string[], at: number) =>
  appendFileSync(path, `${JSON.stringify({ type: "restore", at: new Date(at).toISOString(), ids })}\n`)

/** Gmail's own names for its system labels, as `X-GM-LABELS` takes them. */
const SYSTEM_LABELS = new Set(["Inbox", "Important", "Starred", "Sent", "Drafts", "Spam", "Trash"])
const gmailLabel = (label: string) => (SYSTEM_LABELS.has(label) ? `\\${label}` : label)

/**
 * A cleanup run memo made before the cleanup moved here: memo kept it under its own state folder, one file per run,
 * with every email's labels. It reads as one Gmail step from All Mail to Trash.
 */
const memoRun = (env: NodeJS.ProcessEnv, account: string, id: string): { path: string; run: ChangeRun } | undefined => {
  const root = join(resolvePaths({ appName: "cli-memo", prefix: "MEMO", env }).state, "mail-trash")
  if (!existsSync(root)) return undefined
  for (const name of readdirSync(root)) {
    const path = join(root, name, `${id}.jsonl`)
    if (!existsSync(path)) continue
    const lines = readLines(path) as unknown as Record<string, unknown>[]
    const head = lines.find(({ type }) => type === "run")
    if (String(head?.account ?? "").toLowerCase() !== account.toLowerCase()) continue
    const started = String(head?.started_at ?? "")
    const emails = lines.filter(({ type }) => type === "email")
    const step: StepLine = {
      type: "step",
      step: 1,
      op: "trash",
      folder: "",
      validity: "",
      items: emails.map((line) => ({
        id: String(line.message_id),
        uid: 0,
        labels: ((line.labels as string[] | undefined) ?? []).map(gmailLabel),
      })),
    }
    return {
      path,
      run: {
        run: {
          type: "run",
          id,
          account,
          command: "memo mail delete",
          started_at: started,
          restorable_until: new Date(Date.parse(started) + 30 * 86_400_000).toISOString(),
        },
        // Every logged email, not only those a batch line confirms: a move Gmail made but did not answer leaves none.
        steps: [{ step }],
        restored: new Set(
          lines.filter(({ type }) => type === "restore").flatMap((line) => (line.restored as string[]) ?? []),
        ),
      },
    }
  }
  return undefined
}

/** A run of this mailbox, by the id its answer gave; memo's cleanup runs are found too. */
export const readRun = (env: NodeJS.ProcessEnv, account: string, id: string): { path: string; run: ChangeRun } => {
  if (!RUN_ID.test(id)) throw new CliError("validation_error", "a run id is letters, digits, dots, colons and dashes")
  const path = join(runsDir(env, account), `${id.replace(/[^\w.-]/g, "_")}.jsonl`)
  if (!existsSync(path)) {
    const memo = memoRun(env, account, id)
    if (memo) return memo
    throw new CliError("not_found", `no change run ${id} for ${account}`, { reason: "mail.run-unknown" })
  }
  const lines = readLines(path)
  const run = lines.find((line): line is RunLine => line.type === "run")
  if (!run) throw new CliError("invalid_response", `the record of run ${id} has no start line`)
  const done = new Map(lines.filter((line): line is DoneLine => line.type === "done").map((line) => [line.step, line]))
  return {
    path,
    run: {
      run,
      steps: lines
        .filter((line): line is StepLine => line.type === "step")
        .map((step) => ({ step, ...(done.has(step.step) ? { done: done.get(step.step) as DoneLine } : {}) })),
      restored: new Set(lines.filter((line): line is RestoreLine => line.type === "restore").flatMap(({ ids }) => ids)),
    },
  }
}
