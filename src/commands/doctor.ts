import { existsSync } from "node:fs"
import { dirname } from "node:path"
import { configFilePath, resolvePaths } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import {
  environmentOf,
  itemOf,
  LOCAL_READ,
  outputFor,
  privateFiles,
  profileFree,
  readOnlyLockOf,
  renderAnswer,
} from "@wirecat/cli-core/cli"
import { Command } from "commander"
import { configuration } from "../config.js"
import { IDENTITY } from "../identity.js"

const failure = (error: unknown) => (error instanceof Error ? error.message : String(error))

const configFiles = (path: string) => {
  const files = privateFiles({ files: [path], dirs: [dirname(path)] })
  if (!files.checked) return { files, fixes: [] }
  return {
    files: { ...files, problems: files.problems.map(({ path, mode, want }) => ({ path, mode, want })) },
    fixes: files.problems.map((problem) => problem.fix),
  }
}

/**
 * It is run when everything else is broken, so a problem in the config file is a field in the answer, never a throw.
 * `fixes` are the `chmod` commands that make the config private; they go to stderr, not into the answer.
 */
export const doctorReport = (env: NodeJS.ProcessEnv) => {
  const paths = resolvePaths({ appName: IDENTITY.appName, prefix: IDENTITY.envPrefix, env })
  const common = {
    version: IDENTITY.version,
    runtime: { node: process.versions.node, platform: process.platform },
    paths: { config: paths.config, state: paths.state, cache: paths.cache },
  }
  const readOnly = readOnlyLockOf(IDENTITY, env) ?? null
  try {
    const settings = configuration.resolveSettings({}, { env, readOnly: true, needsProfile: false, withIssues: true })
    const { files, fixes } = configFiles(settings.configPath)
    return {
      report: {
        ...common,
        config: { path: settings.configPath, found: settings.configFound, issues: settings.configIssues ?? [] },
        profiles: settings.configuredProfiles,
        read_only: readOnly,
        files,
      },
      fixes,
    }
  } catch (error) {
    const file = configFilePath(paths.config)
    const { files, fixes } = configFiles(file)
    return {
      report: {
        ...common,
        config: { path: file, found: existsSync(file), issues: [] },
        settings: { error: failure(error) },
        profiles: null,
        read_only: readOnly,
        files,
      },
      fixes,
    }
  }
}

export const doctorCommand = (): Command =>
  profileFree(
    annotate(new Command("doctor"), {
      effects: LOCAL_READ,
      examples: [`${IDENTITY.command} doctor`, `${IDENTITY.command} doctor --json`],
    }),
  )
    .description("check this installation: version, paths, config, profiles; no keyring or network")
    .action(function (this: Command) {
      const env = environmentOf(this).env ?? process.env
      const { report, fixes } = doctorReport(env)
      const output = outputFor(this)
      renderAnswer(this, output, itemOf(report))
      for (const fix of fixes) output.renderer.note(`to make it private: ${fix}`)
    })
