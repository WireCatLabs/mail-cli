import { CliError } from "@wirecat/cli-base"
import type { NextStep } from "@wirecat/cli-base/standards"
import { baseContext, currentRun, itemOf, outputFor, renderAnswer, terminalAsker } from "@wirecat/cli-core/cli"
import { type Asker, guardFor, type SendGuard } from "@wirecat/cli-core/sends"
import type { Command } from "commander"
import * as v from "valibot"
import { configuration } from "../config.js"
import { IDENTITY } from "../identity.js"
import type { MailBackend } from "../mail/backend.js"
import { ChangeLog } from "../mail/changes.js"
import type { locate } from "../mail/locate.js"
import { FILTER_LIMIT, MAX_LIMIT, type Mailbox, type Write } from "../mail/organise.js"
import { DEFAULT_ORGANISE, providerFor } from "../providers.js"
import { openMailStore } from "../store.js"
import { contextOf, openMail, refuseOffline } from "./context.js"
import { worded } from "./words.js"

export type Action = "message-flag" | "message-move" | "message-copy" | "message-delete" | "message-restore"

export const BULK_KEY = "messages.bulk"

export const writeSchema = v.strictObject({
  operation_id: v.string(),
  op: v.picklist(["flag", "label", "move", "copy", "trash"]),
  folder: v.string(),
  to: v.optional(v.string()),
  messages: v.number(),
  undoes: v.optional(v.string()),
})

export const mailChange = v.looseObject({
  action: v.string(),
  applied: v.boolean(),
  run_id: v.nullable(v.string()),
  selected: v.number(),
  located: v.number(),
  changed: v.number(),
  missing: v.number(),
  already_deleted: v.number(),
  in_trash: v.number(),
  more: v.boolean(),
  folders: v.array(v.strictObject({ folder: v.string(), messages: v.number() })),
  to: v.optional(v.string()),
  kept: v.optional(v.record(v.string(), v.number())),
  writes: v.optional(v.array(writeSchema)),
  hint: v.optional(v.string()),
})

export const limitOf = (value: string) => {
  if (!/^\d+$/.test(value.trim()) || Number(value) < 1 || Number(value) > MAX_LIMIT)
    throw new CliError("validation_error", `--limit takes a whole number from 1 to ${MAX_LIMIT}`, { param: "limit" })
  return Number(value)
}

export interface Selection {
  filter?: string
  limit?: number
  dryRun?: boolean
}

/** The y/N question once per key: a change made in several steps asks once. */
const askingOnce = (ask: Asker): Asker => {
  const answered = new Set<string>()
  return async (key, request) => {
    if (answered.has(key)) return
    await ask(key, request)
    answered.add(key)
  }
}

/**
 * The family asks `--allow-dangerous` before a deletion, which cannot be undone in a messenger. Mail's goes to Trash
 * and `messages restore` brings it back, so `--yes` answers it. `--allow-dangerous` is for what is lost for good:
 * `drafts delete`, whose key cli-core does not know as one of those (WC-PERM-9).
 */
const askedByMailFlags =
  (command: Command, ask: Asker): Asker =>
  async (key, request) => {
    const given = command.optsWithGlobals<{ yes?: boolean; allowDangerous?: boolean }>()
    if (key === "messages.delete" && given.yes === true) return
    if (key === "drafts.delete" && given.allowDangerous === true) return
    await ask(key, request)
  }

const commandLine = (command: Command, profile: string) => {
  const path: string[] = []
  for (let at: Command | null = command; at?.parent; at = at.parent) path.unshift(at.name())
  return { path: path.join(" "), line: `${IDENTITY.command} ${profile} ${path.join(" ")}` }
}

export interface Opened {
  mailbox: Mailbox
  backend: MailBackend
  guard: SendGuard
  log: (action: Action, extra?: { restorableUntil?: string; command?: string }) => ChangeLog
  profile: string
  env: NodeJS.ProcessEnv
  line: string
  path: string
  /** Holds the command's answer until the store and the mailbox are closed; a failed close drops it (WC-LIFE-4). */
  answer: (show: () => void) => void
  /** Records that a message left, so a close that fails after it still names the operation a retry checks. */
  sent: (operationId: string) => void
}

export const stringsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((one): one is string => typeof one === "string") : []

const closedAfterSending = (operationId: string, error: unknown) =>
  new CliError(
    "outcome_unknown",
    `the message was probably sent, but the store did not close (${error instanceof Error ? error.message : String(error)}); ` +
      `repeat the command with --operation-id ${operationId}: it looks in Sent first and does not send it twice`,
    { operation_id: operationId, retryable: false },
  )

/** Opens the store and the mailbox for one write command, and closes both after `work`, then answers. */
export const organising = async <T>(command: Command, work: (opened: Opened) => Promise<T>): Promise<T> => {
  const context = contextOf(command)
  refuseOffline(context.flags)
  const address = context.settings.mailbox.address
  if (!address) throw new CliError("configuration_error", `profile ${context.profile} has no address`)
  const { backend } = await openMail(context)
  let shown: (() => void) | undefined
  let sent: string | undefined
  let result: T
  try {
    result = await worded(context.profile, () =>
      baseContext(command, configuration.resolveSettings).run(async () => {
        const writes = backend.writes
        if (!writes) throw new CliError("provider_unavailable", "this mailbox cannot be changed from here")
        const store = await openMailStore(context.env)
        context.environment.trackCloseable?.(store)
        let worked = false
        try {
          const key = { provider: "email", account: address.toLowerCase() }
          const stored = await store.accounts.storedAccount(key).catch(() => null)
          if (stored === null)
            throw new CliError(
              "not_found",
              `no mail of ${address} is stored yet; run \`${IDENTITY.command} ${context.profile} sync\` first`,
            )
          let folders: Awaited<ReturnType<typeof backend.folderList>> | undefined
          const mailbox: Mailbox = {
            app: IDENTITY,
            store,
            key,
            accountId: stored.id,
            writes,
            folders: async () => {
              folders ??= await backend.folderList()
              return folders
            },
            organise: providerFor(address, context.settings.mailbox.host)?.organise ?? DEFAULT_ORGANISE,
            now: Date.now,
          }
          // baseContext adds an MCP server's own --permission overrides, which a key checked only here would miss.
          const { settings } = baseContext(command, configuration.resolveSettings)
          const guard = guardFor(
            IDENTITY,
            { ...settings, permissionDefaults: configuration.permissions?.defaults ?? {} },
            (message) => outputFor(command).renderer.warn(message),
            context.env,
            askingOnce(askedByMailFlags(command, terminalAsker(command))),
          )
          const { path, line } = commandLine(command, context.profile)
          const done = await work({
            mailbox,
            backend,
            guard,
            profile: context.profile,
            env: context.env,
            path,
            line,
            answer: (show) => {
              shown = show
            },
            sent: (operationId) => {
              sent = operationId
            },
            log: (_action, extra = {}) =>
              new ChangeLog(context.env, {
                type: "run",
                id: currentRun().runId,
                account: key.account,
                command: extra.command ?? line,
                started_at: new Date().toISOString(),
                ...(extra.restorableUntil ? { restorable_until: extra.restorableUntil } : {}),
              }),
          })
          worked = true
          return done
        } finally {
          await store.close().catch((error: unknown) => {
            // The command's own error wins: it may already name the operation a retry needs.
            if (!worked) return
            throw sent === undefined ? error : closedAfterSending(sent, error)
          })
        }
      }),
    )
  } finally {
    await backend.close()
  }
  shown?.()
  return result
}

/** A bulk change is checked as `messages.bulk` too, before anything is sent, so an owner can stop agents doing many. */
export const checkBulk = async (guard: SendGuard, count: number) => {
  const probe = { chatId: null, kind: "read" as const, key: BULK_KEY, count }
  await guard.ask?.(probe)
  guard.check(probe, { reserve: false })
}

export interface Planned {
  action: string
  selected: { ids: string[]; more: boolean }
  located: Awaited<ReturnType<typeof locate>>
  to?: string
  kept?: Partial<Record<string, number>>
}

export const restoreHint = (opened: Opened, run: string) =>
  `${IDENTITY.command} ${opened.profile} messages restore --run ${run} --yes undoes it`

/** Previews unless `--yes` (or always under `--dry-run`); a single small change that only flags or moves needs none. */
export const answerChange = (
  command: Command,
  opened: Opened,
  plan: Planned,
  outcome: { run: string; changed: string[]; kept?: Record<string, number>; writes: Write[] } | null,
  given: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => {
  const { located, selected } = plan
  const folders = located.located.map(({ folder, items }) => ({ folder, messages: items.length }))
  const count = located.located.reduce((sum, { items }) => sum + items.length, 0)
  const kept = { ...plan.kept, ...outcome?.kept }
  const next: NextStep[] = outcome
    ? [
        {
          kind: "command",
          step: "mail.restore",
          command: "messages restore",
          args: { run: outcome.run },
          why: "puts back what this run changed, while the server still holds it",
          safe_to_auto_execute: false,
        },
      ]
    : count > 0
      ? [
          {
            kind: "command",
            step: "mail.apply",
            command: opened.path,
            args: { ...given, yes: true },
            why: "this was a preview; the same command with --yes makes the change",
            safe_to_auto_execute: false,
          },
        ]
      : []
  opened.answer(() =>
    renderAnswer(
      command,
      outputFor(command),
      itemOf(
        {
          action: plan.action,
          applied: outcome !== null,
          run_id: outcome?.run ?? null,
          selected: selected.ids.length,
          located: count,
          changed: outcome?.changed.length ?? 0,
          missing: located.missing.length,
          already_deleted: located.deleted.length,
          in_trash: located.inTrash.length,
          more: selected.more,
          folders,
          ...(plan.to ? { to: plan.to } : {}),
          ...(Object.keys(kept).length ? { kept } : {}),
          ...(outcome ? { writes: outcome.writes } : {}),
          ...extra,
          ...(outcome
            ? { hint: restoreHint(opened, outcome.run) }
            : count > 0
              ? { hint: `a preview: nothing changed; add --yes to change ${count}` }
              : {}),
        },
        { next },
      ),
    ),
  )
}

export const selection = (command: Command, max = FILTER_LIMIT) =>
  command
    .argument("[message...]", "msg:email/… references, as search messages shows them")
    .option("--filter <query>", "the stored mail this query finds, instead of references (search messages syntax)")
    .option(
      "--limit <n>",
      `with --filter, at most this many, newest first (default ${max}, at most ${MAX_LIMIT})`,
      limitOf,
    )
    .option("--yes", "make the change; a deletion or a change of many is only a preview without it")
    .option("--dry-run", "only preview what would change, even with --yes")

export const yesOf = (command: Command) => command.optsWithGlobals<{ yes?: boolean }>().yes === true

export const givenArgs = (refs: string[], options: Selection) => ({
  ...(refs.length ? { message: refs } : {}),
  ...(options.filter === undefined ? {} : { filter: options.filter }),
  ...(options.limit === undefined ? {} : { limit: options.limit }),
})
