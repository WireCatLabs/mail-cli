import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import {
  answerEntity,
  baseContext,
  itemOf,
  LOCAL_READ,
  listOf,
  outputFor,
  REMOTE_READ,
  REMOTE_WRITE,
  renderAnswer,
  terminalAsker,
} from "@wirecat/cli-core/cli"
import { guardedWrite, guardFor, newOperationId } from "@wirecat/cli-core/sends"
import { Command } from "commander"
import * as v from "valibot"
import { configuration } from "../config.js"
import { IDENTITY } from "../identity.js"
import { folderNamed } from "../mail/organise.js"
import { contextOf, openMail, refuseOffline } from "./context.js"

const mailFolder = v.strictObject({
  path: v.string(),
  name: v.string(),
  role: v.nullable(v.string()),
  messages: v.nullable(v.number()),
  unseen: v.nullable(v.number()),
})

const listCommand = () =>
  answerEntity(
    annotate(new Command("list"), {
      effects: REMOTE_READ,
      examples: [`${IDENTITY.command} ya folders list`, `${IDENTITY.command} ya folders list --json`],
    }),
    "mail_folder",
    mailFolder,
  )
    .summary("the folders with their role and message counts")
    .description("the folders of the mailbox with their role (inbox, sent, trash, ...) and message counts")
    .action(async function (this: Command) {
      const context = contextOf(this)
      refuseOffline(context.flags)
      const { backend } = await openMail(context)
      try {
        const folders = await baseContext(this, configuration.resolveSettings).run(() => backend.folderList())
        renderAnswer(
          this,
          outputFor(this),
          listOf("folders list", { items: folders, limit: Math.max(1, folders.length), has_more: false }),
        )
      } finally {
        await backend.close()
      }
    })

const folderChange = v.strictObject({
  action: v.picklist(["create", "rename", "delete"]),
  folder: v.string(),
  to: v.optional(v.string()),
  messages: v.optional(v.number()),
})

type FolderAction = "create" | "rename" | "delete"

const ACTIONS = { create: "folder-create", rename: "folder-update", delete: "folder-delete" } as const

/** One change to the folders, under the write guard: the read-only lock, the profile's level and the journal. */
const changeFolder = async (
  command: Command,
  action: FolderAction,
  work: (
    writes: NonNullable<Awaited<ReturnType<typeof openMail>>["backend"]["writes"]>,
    folders: FolderList,
  ) => Promise<{
    folder: string
    to?: string
    messages?: number
  }>,
) => {
  const context = contextOf(command)
  refuseOffline(context.flags)
  const { backend } = await openMail(context)
  try {
    const done = await baseContext(command, configuration.resolveSettings).run(async () => {
      const writes = backend.writes
      if (!writes) throw new CliError("provider_unavailable", "this mailbox cannot be changed from here")
      const guard = guardFor(
        IDENTITY,
        { ...context.settings, permissionDefaults: configuration.permissions?.defaults ?? {} },
        (message) => outputFor(command).renderer.warn(message),
        context.env,
        terminalAsker(command),
      )
      const folders = await backend.folderList()
      return guardedWrite(
        guard,
        {
          chatId: null,
          kind: "account",
          action: ACTIONS[action],
          key: `folders.${action}`,
          operationId: newOperationId(),
        },
        () => work(writes, folders),
      )
    })
    renderAnswer(command, outputFor(command), itemOf({ action, ...done }))
  } finally {
    await backend.close()
  }
}

type FolderList = Awaited<ReturnType<Awaited<ReturnType<typeof openMail>>["backend"]["folderList"]>>

const existing = (folders: FolderList, given: string) => {
  const found = folderNamed(folders, given)
  if (!found) throw new CliError("not_found", `no folder "${given}"; folders list shows them`, { param: "folder" })
  return found
}

const createCommand = () =>
  answerEntity(
    annotate(new Command("create"), {
      effects: REMOTE_WRITE,
      examples: [`${IDENTITY.command} ya folders create Receipts`, `${IDENTITY.command} ya folders create Work/2026`],
    }),
    "mail_folder_change",
    folderChange,
  )
    .summary("make a folder")
    .description("make a folder on the server; on Gmail it is a label")
    .argument("<folder>", "the folder's path; the server's separator (usually / or .) makes a subfolder")
    .action(async function (this: Command, folder: string) {
      await changeFolder(this, "create", async (writes, folders) => {
        if (folders.some(({ path }) => path === folder))
          throw new CliError("validation_error", `folder "${folder}" already exists`, { param: "folder" })
        await writes.createFolder(folder)
        return { folder }
      })
    })

const renameCommand = () =>
  answerEntity(
    annotate(new Command("rename"), {
      effects: REMOTE_WRITE,
      examples: [`${IDENTITY.command} ya folders rename Receipts Invoices`],
    }),
    "mail_folder_change",
    folderChange,
  )
    .summary("rename a folder")
    .description("rename a folder of your own on the server; the inbox and the special folders keep their names")
    .argument("<folder>", "the folder, by path or name")
    .argument("<name>", "its new path")
    .action(async function (this: Command, folder: string, name: string) {
      await changeFolder(this, "rename", async (writes, folders) => {
        const found = existing(folders, folder)
        if (found.role)
          throw new CliError("validation_error", `${found.path} is the ${found.role} folder; it keeps its name`)
        await writes.renameFolder(found.path, name)
        return { folder: found.path, to: name }
      })
    })

const deleteFolderCommand = () =>
  answerEntity(
    annotate(new Command("delete"), {
      effects: REMOTE_WRITE,
      examples: [`${IDENTITY.command} ya folders delete Old --yes`],
    }),
    "mail_folder_change",
    folderChange,
  )
    .summary("delete an empty folder")
    .description(
      "delete a folder of your own; it must be empty (move or delete its mail first), unless --allow-dangerous, which loses that mail for good",
    )
    .argument("<folder>", "the folder, by path or name")
    .option("--allow-dangerous", "delete a folder that still holds mail: that mail is gone for good, no restore")
    .action(async function (this: Command, folder: string) {
      // The shared program reads --allow-dangerous as its own flag, so the value is among the globals.
      const dangerous = this.optsWithGlobals<{ allowDangerous?: boolean }>().allowDangerous === true
      await changeFolder(this, "delete", async (writes, folders) => {
        const found = existing(folders, folder)
        if (found.role) throw new CliError("validation_error", `${found.path} is the ${found.role} folder; it stays`)
        if ((found.messages ?? 0) > 0 && !dangerous)
          throw new CliError(
            "validation_error",
            `${found.path} holds ${found.messages} messages; move them out first (messages move --filter 'mailbox:"${found.path}"' --folder …), or --allow-dangerous to lose them`,
            { reason: "mail.folder-not-empty" },
          )
        await writes.deleteFolder(found.path)
        return { folder: found.path, messages: found.messages ?? 0 }
      })
    })

export const foldersCommand = (): Command =>
  annotate(new Command("folders"), { effects: LOCAL_READ })
    .description("the folders of this profile's mailbox")
    .addCommand(listCommand())
    .addCommand(createCommand())
    .addCommand(renameCommand())
    .addCommand(deleteFolderCommand())
