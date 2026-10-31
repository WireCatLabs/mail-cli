import { annotate } from "@wirecat/cli-base/commands"
import {
  answerEntity,
  baseContext,
  itemOf,
  LOCAL_READ,
  outputFor,
  REMOTE_READ,
  renderAnswer,
} from "@wirecat/cli-core/cli"
import { Command } from "commander"
import * as v from "valibot"
import { configuration } from "../config.js"
import { IDENTITY } from "../identity.js"
import { contextOf, openSource, refuseOffline } from "./context.js"

const mailAccountCheck = v.strictObject({
  profile: v.string(),
  host: v.string(),
  port: v.number(),
  security: v.picklist(["tls", "starttls", "plain"]),
  password_from: v.picklist(["environment", "keyring", "himalaya"]),
  login: v.string(),
  capabilities: v.array(v.string()),
  features: v.record(v.string(), v.boolean()),
  folders: v.number(),
})

const checkCommand = () =>
  answerEntity(
    annotate(new Command("check"), {
      effects: REMOTE_READ,
      examples: [`${IDENTITY.command} ya account check`, `${IDENTITY.command} ya account check --json`],
    }),
    "mail_account_check",
    mailAccountCheck,
  )
    .summary("log in and list what the server supports")
    .description("log in to the server and list what it supports (IDLE, CONDSTORE, MOVE, Gmail extensions)")
    .action(async function (this: Command) {
      const context = contextOf(this)
      refuseOffline(context.flags)
      const { source, endpoint, passwordFrom } = await openSource(context)
      try {
        const checked = await baseContext(this, configuration.resolveSettings).run(() => source.check())
        renderAnswer(
          this,
          outputFor(this),
          itemOf({
            profile: context.profile,
            host: endpoint.host,
            port: endpoint.port,
            security: endpoint.security,
            password_from: passwordFrom,
            ...checked,
          }),
        )
      } finally {
        await source.close()
      }
    })

export const accountCommand = (): Command =>
  annotate(new Command("account"), { effects: LOCAL_READ })
    .description("the mailbox behind this profile")
    .addCommand(checkCommand())
