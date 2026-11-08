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
  /** The write's own id in the send journal; absent in runs logged before mail 0.17. */
  operation_id?: string
  /** For a restore's step, the `operation_id` of the step it undoes. */
  undoes?: string
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
  /** The write these messages came back from; without it (an older restore, a step with no id) it counts for all. */
  undoes?: string
}

type Line = RunLine | StepLine | DoneLine | RestoreLine | { type: "end"; ended_at: string }

export interface ChangeRun {
  run: RunLine
  steps: { step: StepLine; done?: DoneLine }[]
  /** Whether a restore already brought this message of this step back. */
  restored: (step: StepLine, id: string) => boolean
}

const RUN_ID = /^[\w.:-]+$/

export const runsDir = (env: NodeJS.ProcessEnv, account: string) =>
  join(resolvePaths({ appName: "mail-cli", prefix: "MAIL", env }).state, "changes", account.toLowerCase())

const LINE_TYPES: readonly unknown[] = ["run", "step", "done", "restore", "end"]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

/** Only this tool writes these files; a line is trusted to have its type's fields once its type is one of ours. */
const isLine = (value: Record<string, unknown>): value is Line & Record<string, unknown> =>
  LINE_TYPES.includes(value.type)

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((one): one is string => typeof one === "string") : []

const readRecords = (path: string): Record<string, unknown>[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((text) => {
      try {
        const parsed: unknown = JSON.parse(text)
        return isRecord(parsed) ? [parsed] : []
      } catch {
        // A torn last line from a run that died; the lines before it still say what happened.
        return []
      }
    })

const readLines = (path: string): Line[] => readRecords(path).filter(isLine)

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

export const appendRestore = (path: string, ids: string[], at: number, undoes?: string) => {
  // A file another program wrote may end without a newline, and the line would join its last one and be lost.
  const lead = readFileSync(path, "utf8").endsWith("\n") ? "" : "\n"
  const line: RestoreLine = { type: "restore", at: new Date(at).toISOString(), ids, ...(undoes ? { undoes } : {}) }
  appendFileSync(path, `${lead}${JSON.stringify(line)}\n`)
}

/**
 * What came back, per write: a line naming the write it undid counts for that write alone, so undoing one write of a
 * message leaves the run's other writes of it to a later restore.
 */
const restoredOf = (lines: Line[]) => {
  const all = new Set<string>()
  const byWrite = new Map<string, Set<string>>()
  for (const line of lines) {
    if (line.type !== "restore") continue
    const into = line.undoes ? (byWrite.get(line.undoes) ?? new Set<string>()) : all
    if (line.undoes) byWrite.set(line.undoes, into)
    for (const id of line.ids) into.add(id)
  }
  return (step: Pick<StepLine, "operation_id">, id: string) =>
    all.has(id) || (step.operation_id !== undefined && (byWrite.get(step.operation_id)?.has(id) ?? false))
}

/** Gmail's own names for its system labels, as `X-GM-LABELS` takes them. */
const SYSTEM_LABELS = new Set(["Inbox", "Important", "Starred", "Sent", "Drafts", "Spam", "Trash"])
const gmailLabel = (label: string) => (SYSTEM_LABELS.has(label) ? `\\${label}` : label)

/** What came back from a memo run: memo wrote `restored`, a restore made here writes `ids`. */
const memoRestored = (lines: Record<string, unknown>[]) =>
  new Set(
    lines.filter(({ type }) => type === "restore").flatMap((line) => [...strings(line.restored), ...strings(line.ids)]),
  )

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
    const lines = readRecords(path)
    const head = lines.find(({ type }) => type === "run")
    if (String(head?.account ?? "").toLowerCase() !== account.toLowerCase()) continue
    const started = String(head?.started_at ?? "")
    const emails = lines.filter(({ type }) => type === "email")
    const back = memoRestored(lines)
    const step: StepLine = {
      type: "step",
      step: 1,
      op: "trash",
      folder: "",
      validity: "",
      items: emails.map((line) => ({
        id: String(line.message_id),
        uid: 0,
        labels: strings(line.labels).map(gmailLabel),
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
        restored: (_step, one) => back.has(one),
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
        .map((step) => {
          const finished = done.get(step.step)
          return { step, ...(finished ? { done: finished } : {}) }
        }),
      restored: restoredOf(lines),
    },
  }
}

export interface RunSummary {
  id: string
  account: string
  command: string
  started_at: string
  /** No end line: the process stopped part way, so some steps may be done and others not. */
  unfinished: boolean
  restorable_until: string | null
  /** Moved to Trash and not restored since. */
  in_trash: number
}

const summaryOf = (lines: Line[]): RunSummary | undefined => {
  const run = lines.find((line): line is RunLine => line.type === "run")
  if (!run) return undefined
  const done = new Set(
    lines
      .filter((line): line is DoneLine => line.type === "done")
      .flatMap(({ step, ids }) => ids.map((one) => `${step}:${one}`)),
  )
  const restored = restoredOf(lines)
  const trashed = new Set(
    lines
      .filter((line): line is StepLine => line.type === "step" && line.op === "trash")
      .flatMap((step) =>
        step.items.filter(({ id }) => done.has(`${step.step}:${id}`) && !restored(step, id)).map(({ id }) => id),
      ),
  )
  return {
    id: run.id,
    account: run.account,
    command: run.command,
    started_at: run.started_at,
    unfinished: !lines.some(({ type }) => type === "end"),
    restorable_until: run.restorable_until ?? null,
    in_trash: trashed.size,
  }
}

/** memo's cleanup runs, from before the cleanup moved here: `email` lines are what it moved, `restore` what came back. */
const memoSummaries = (env: NodeJS.ProcessEnv): RunSummary[] => {
  const root = join(resolvePaths({ appName: "cli-memo", prefix: "MEMO", env }).state, "mail-trash")
  if (!existsSync(root)) return []
  return readdirSync(root).flatMap((name) =>
    readdirSync(join(root, name))
      .filter((file) => file.endsWith(".jsonl"))
      .flatMap((file) => {
        const lines = readRecords(join(root, name, file))
        const head = lines.find(({ type }) => type === "run")
        if (!head) return []
        const started = String(head.started_at ?? "")
        const restored = memoRestored(lines)
        const moved = lines.filter(({ type }) => type === "batch").flatMap((line) => strings(line.moved))
        return [
          {
            id: file.replace(/\.jsonl$/, ""),
            account: String(head.account ?? name),
            command: "memo mail delete",
            started_at: started,
            unfinished: !lines.some(({ type }) => type === "end"),
            restorable_until: new Date(Date.parse(started) + 30 * 86_400_000).toISOString(),
            in_trash: moved.filter((one) => !restored.has(one)).length,
          },
        ]
      }),
  )
}

/** Every recorded run on this computer, of every mailbox, memo's cleanup runs included; newest first. */
export const runSummaries = (env: NodeJS.ProcessEnv): RunSummary[] => {
  const root = join(resolvePaths({ appName: "mail-cli", prefix: "MAIL", env }).state, "changes")
  const own = existsSync(root)
    ? readdirSync(root).flatMap((account) =>
        readdirSync(join(root, account))
          .filter((file) => file.endsWith(".jsonl"))
          .flatMap((file) => summaryOf(readLines(join(root, account, file))) ?? []),
      )
    : []
  return [...own, ...memoSummaries(env)].sort((a, b) => b.started_at.localeCompare(a.started_at))
}
