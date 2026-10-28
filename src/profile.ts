import { CliError, configFilePath, resolvePaths, saveConfigFile } from "@wirecat/cli-base"
import { readConfigFile, usableProfileName } from "@wirecat/cli-core/cli"
import type { Discovery } from "./discovery.js"
import { IDENTITY } from "./identity.js"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const configPath = (env: NodeJS.ProcessEnv): string =>
  configFilePath(resolvePaths({ appName: IDENTITY.appName, prefix: IDENTITY.envPrefix, env }).config)

/** The profile name `mail setup` proposes: the part before the @, cleaned to what a profile name allows. */
export const proposedName = (address: string): string => {
  const local = (address.split("@")[0] ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/^[^a-z0-9]+/, "")
  return usableProfileName(local || "mail")
}

export const profileOf = (discovery: Discovery, folders?: string[]) => ({
  address: discovery.address,
  ...(discovery.login === discovery.address ? {} : { login: discovery.login }),
  imap_host: discovery.imap.host,
  imap_port: discovery.imap.port,
  imap_security: discovery.imap.security,
  ...(folders?.length ? { folders } : {}),
})

/** Adds one profile to the config file; an existing profile is replaced only when `replace` is true. */
export const writeProfile = (
  env: NodeJS.ProcessEnv,
  name: string,
  profile: Record<string, unknown>,
  replace: boolean,
): { path: string; created: boolean } => {
  usableProfileName(name)
  const path = configPath(env)
  const read = readConfigFile(path)
  if ("issue" in read)
    throw new CliError("configuration_error", `${path} cannot be read; run \`${IDENTITY.command} doctor\``)
  const config = isRecord(read.raw) ? read.raw : {}
  const profiles = isRecord(config.profiles) ? config.profiles : {}
  const existed = name in profiles
  if (existed && !replace)
    throw new CliError("validation_error", `profile ${name} already exists; pass --replace to overwrite it`, {
      param: "name",
    })
  saveConfigFile(path, { ...config, profiles: { ...profiles, [name]: profile } })
  return { path, created: !existed }
}
