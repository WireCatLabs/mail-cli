import { join } from "node:path"
import { resolvePaths } from "@wirecat/cli-base"
import {
  appDoctorCommand,
  appMcpCommand,
  baseContext,
  commandsCommand,
  configCommand,
  createProgram as createSharedProgram,
  outputFor,
  type ProgramDefinition,
  type ProgramOptions,
  type RunOptions,
  run as runShared,
  runsCommand,
  scheduleCommandFor,
  skillCommand,
  upgradeCommand,
} from "@wirecat/cli-core/cli"
import { appUpdate } from "@wirecat/cli-core/update"
import type { Command } from "commander"
import { accountCommand } from "./commands/account.js"
import { attachmentsCommand } from "./commands/attachments.js"
import { draftsCommand } from "./commands/drafts.js"
import { foldersCommand } from "./commands/folders.js"
import { messageWrites } from "./commands/messages.js"
import { readCommands } from "./commands/read.js"
import { rulesCommand } from "./commands/rules.js"
import { forwardCommand, sendCommand } from "./commands/send.js"
import { sessionCommand } from "./commands/session.js"
import { statsCommand } from "./commands/stats.js"
import { statusCommand } from "./commands/status.js"
import { syncCommand } from "./commands/sync.js"
import { tagsCommand } from "./commands/tags.js"
import { configuration } from "./config.js"
import { IDENTITY, PACKAGE, SKILL } from "./identity.js"
import { changesCheck } from "./mail/doctor.js"

const update = appUpdate({
  packageName: PACKAGE,
  command: IDENTITY.command,
  version: IDENTITY.version,
  entry: import.meta.url,
  statePath: (env) =>
    join(resolvePaths({ appName: IDENTITY.appName, prefix: IDENTITY.envPrefix, env }).state, "update-check.json"),
  enabled: (env) => configuration.resolveSettings({}, { env, needsProfile: false }).updateCheck,
  offVariables: [`${IDENTITY.envPrefix}_NO_UPDATE_CHECK`],
})

/** cli-core's `messages` group reads; the changes to a mailbox go beside `messages show`. */
const withWrites = (reads: Command[]): Command[] => {
  const messages = reads.find((one) => one.name() === "messages")
  if (!messages) throw new Error("cli-core's mail reads have no messages group")
  for (const write of [...messageWrites(), sendCommand(), forwardCommand()]) messages.addCommand(write)
  return reads
}

export const definition = (): ProgramDefinition => ({
  app: IDENTITY,
  firstScreen: { start: `${IDENTITY.command} personal session start --address <email>` },
  configuration,
  commands: () => [
    commandsCommand(IDENTITY),
    sessionCommand(),
    accountCommand(),
    foldersCommand(),
    syncCommand(),
    rulesCommand(),
    statusCommand(),
    ...withWrites(readCommands()),
    attachmentsCommand(),
    statsCommand(),
    draftsCommand(),
    tagsCommand(),
    appDoctorCommand(IDENTITY, configuration, { packageName: PACKAGE, local: changesCheck }),
    skillCommand(IDENTITY, SKILL),
    appMcpCommand(IDENTITY, configuration, {
      name: "mail",
      untrusted: ["subjects", "bodies", "HTML parts", "headers", "sender names", "folder names", "file names"],
      permissionExample: "sync=deny",
      skill: SKILL,
    }),
    upgradeCommand(IDENTITY, PACKAGE, (command) => ({
      ...outputFor(command),
      installer: () => update.installer({}),
      latest: () => update.latest({}),
      install: (argv) => update.runUpdate(argv, {}),
    })),
    configCommand(IDENTITY, configuration),
    runsCommand(IDENTITY),
    scheduleCommandFor({
      app: IDENTITY,
      context: (command, resolving) => {
        const base = baseContext(command, (flags, options) =>
          configuration.resolveSettings(flags, { ...options, ...resolving }),
        )
        return { ...base, profile: base.settings.profile }
      },
    }),
  ],
})

export const createProgram = (options?: ProgramOptions): Command => createSharedProgram(definition(), options)

export const run = (argv: string[], options?: RunOptions): Promise<number> => runShared(argv, definition(), options)
