import { resolve } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { answerEntity, FETCH, itemOf, listOf, outputFor, REMOTE_READ, renderAnswer } from "@wirecat/cli-core/cli"
import { parseMail } from "@wirecat/cli-core/mail"
import { refusedPlace } from "@wirecat/cli-core/sends"
import { Command } from "commander"
import * as v from "valibot"
import { IDENTITY } from "../identity.js"
import { distinctNames, refuseExisting, safeName, savePrivately } from "../mail/save.js"
import { fetchOriginal } from "../mail/send.js"
import { contextOf } from "./context.js"
import { type Opened, organising } from "./messages.js"

const REF_EXAMPLE = "'msg:email/me%40example.com/thread-1/1001'"

const attachment = v.strictObject({
  number: v.number(),
  name: v.string(),
  mime: v.nullable(v.string()),
  bytes: v.number(),
})

const saved = v.looseObject({
  folder: v.string(),
  files: v.array(v.strictObject({ number: v.number(), name: v.string(), path: v.string(), bytes: v.number() })),
})

/** The message's attachments as the store numbered them at sync: the same parser, so the same order and names. */
const attachmentsOf = async (opened: Opened, reference: string) => {
  const { raw } = await fetchOriginal(opened.mailbox, opened.backend, reference, opened.profile)
  const parsed = await parseMail(raw, undefined, Number.POSITIVE_INFINITY)
  const names = distinctNames(parsed.attachments.map(({ id, name }) => safeName(name, `attachment-${id + 1}`)))
  return parsed.attachments.map((one, at) => ({
    number: one.id + 1,
    name: names[at] as string,
    mime: one.mime,
    bytes: one.bytes?.byteLength ?? 0,
    content: one.bytes ?? new Uint8Array(),
  }))
}

const listCommand = (): Command =>
  answerEntity(
    annotate(new Command("list"), {
      effects: REMOTE_READ,
      examples: [`${IDENTITY.command} ya attachments list ${REF_EXAMPLE}`],
    }),
    "mail_attachment",
    attachment,
  )
    .summary("the files attached to one email, read from the server")
    .description(
      "the attachments of one stored email, numbered as attachments download takes them; reads the message from the server",
    )
    .argument("<message>", "the msg:email/… reference search messages shows")
    .action(async function (this: Command, reference: string) {
      const found = await organising(this, (opened) => attachmentsOf(opened, reference))
      const items = found.map(({ content: _, ...one }) => one)
      renderAnswer(
        this,
        outputFor(this),
        listOf("attachments list", { items, limit: Math.max(1, items.length), has_more: false }),
        () =>
          items.length
            ? items.map(({ number, name, bytes }) => `${number}  ${name}  ${bytes} bytes\n`).join("")
            : "no attachments\n",
      )
    })

interface DownloadFlags {
  outputDir: string
  replace?: boolean
}

const numbersOf = (given: readonly string[]) =>
  given.map((value) => {
    if (!/^\d+$/.test(value.trim()) || Number(value) < 1)
      throw new CliError("validation_error", "a number is an attachment's number from attachments list", {
        param: "number",
      })
    return Number(value)
  })

const downloadCommand = (): Command =>
  answerEntity(
    annotate(new Command("download"), {
      effects: FETCH,
      examples: [
        `${IDENTITY.command} ya attachments download ${REF_EXAMPLE} --output-dir ./invoices`,
        `${IDENTITY.command} ya attachments download ${REF_EXAMPLE} 2 --output-dir ./invoices`,
      ],
    }),
    "mail_attachments_saved",
    saved,
  )
    .summary("save the files attached to one email")
    .description(
      "save the attachments of one stored email into a folder, readable only by you; the bytes come from the server " +
        "and never go into the store. An existing file is left alone unless --replace",
    )
    .argument("<message>", "the msg:email/… reference search messages shows")
    .argument("[number...]", "only these attachments, by their number in attachments list (default: all)")
    .requiredOption("--output-dir <dir>", "the folder to save into, made if missing")
    .option("--replace", "overwrite a file of the same name in the folder")
    .action(async function (this: Command, reference: string, given: string[], flags: DownloadFlags) {
      const numbers = numbersOf(given)
      const folder = resolve(flags.outputDir)
      if (refusedPlace(folder, IDENTITY, contextOf(this).env))
        throw new CliError(
          "validation_error",
          `will not save into ${flags.outputDir}: credential folders and the WireCat apps' folders are not written to`,
          { param: "output-dir" },
        )
      const found = await organising(this, (opened) => attachmentsOf(opened, reference))
      const wanted = numbers.length ? found.filter(({ number }) => numbers.includes(number)) : found
      const missing = numbers.filter((number) => !found.some((one) => one.number === number))
      if (missing.length)
        throw new CliError("not_found", `the message has no attachment ${missing.join(", ")}; it has ${found.length}`, {
          param: "number",
        })
      const files = wanted.map((one) => ({ ...one, path: resolve(folder, one.name) }))
      if (!flags.replace) for (const { path } of files) refuseExisting(path)
      for (const { path, content } of files) await savePrivately(path, content, flags.replace === true)
      renderAnswer(
        this,
        outputFor(this),
        itemOf({ folder, files: files.map(({ number, name, path, bytes }) => ({ number, name, path, bytes })) }),
        () =>
          files.length ? files.map(({ path, bytes }) => `${path}  ${bytes} bytes\n`).join("") : "no attachments\n",
      )
    })

export const attachmentsCommand = (): Command =>
  new Command("attachments")
    .summary("list and save the files attached to an email")
    .addCommand(listCommand())
    .addCommand(downloadCommand())
