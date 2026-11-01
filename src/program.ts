import { join } from "node:path"
import { resolvePaths } from "@wirecat/cli-base"
import {
  appDoctorCommand,
  appMcpCommand,
  commandsCommand,
  configCommand,
  createProgram as createSharedProgram,
  outputFor,
  type ProgramDefinition,
  type ProgramOptions,
  type RunOptions,
  run as runShared,
  runsCommand,
  skillCommand,
  upgradeCommand,
} from "@wirecat/cli-core/cli"
import { appUpdate } from "@wirecat/cli-core/update"
import type { Command } from "commander"
import { accountCommand } from "./commands/account.js"
import { foldersCommand } from "./commands/folders.js"
import { readCommands } from "./commands/read.js"
import { sessionCommand } from "./commands/session.js"
import { statusCommand } from "./commands/status.js"
import { syncCommand } from "./commands/sync.js"
import { configuration } from "./config.js"
import { IDENTITY, PACKAGE, SKILL } from "./identity.js"

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
    statusCommand(),
    ...readCommands(),
    appDoctorCommand(IDENTITY, configuration, { packageName: PACKAGE }),
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
  ],
})

export const createProgram = (options?: ProgramOptions): Command => createSharedProgram(definition(), options)

export const run = (argv: string[], options?: RunOptions): Promise<number> => runShared(argv, definition(), options)
