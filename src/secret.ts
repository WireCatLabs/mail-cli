import { execFile } from "node:child_process"
import { CliError, Credentials, isMovedRun, type KeyringStore, resolvePaths, systemKeyring } from "@wirecat/cli-base"
import { IDENTITY } from "./identity.js"

export type PasswordSource = "environment" | "keyring" | "himalaya"

export type LookupHimalaya = (account: string) => Promise<string | undefined>

/** Reads the entry Himalaya's setup left (`secret-tool … service himalaya account <name>`); no shell, no secret in argv. */
export const secretToolLookup: LookupHimalaya = (account) =>
  new Promise((resolve) => {
    execFile(
      "secret-tool",
      ["lookup", "service", "himalaya", "account", account],
      { timeout: 5000, maxBuffer: 64 * 1024, encoding: "utf8" },
      (error, stdout) => resolve(error ? undefined : stdout.replace(/\r?\n$/, "") || undefined),
    )
  })

export interface PasswordOptions {
  env: NodeJS.ProcessEnv
  profile: string
  keyring?: KeyringStore | undefined
  himalaya?: LookupHimalaya | undefined
}

/** The app password of one profile. The keyring only: a password never falls back to a file. */
export const passwordStore = ({ env, profile, keyring = systemKeyring, himalaya }: PasswordOptions) => {
  // cli-base gives a moved run a temporary entry only with the system keyring; this check must agree with it.
  const moved = keyring === systemKeyring && isMovedRun({ appName: IDENTITY.appName, prefix: IDENTITY.envPrefix, env })
  const credentials = new Credentials({
    configDir: resolvePaths({ appName: IDENTITY.appName, prefix: IDENTITY.envPrefix, env }).config,
    service: IDENTITY.appName,
    isolated: moved,
    envVar: `${IDENTITY.envPrefix}_PASSWORD`,
    storage: "keyring",
    keyring,
    env,
  })
  return {
    read: async (): Promise<{ secret: string; source: PasswordSource } | undefined> => {
      let stored: ReturnType<Credentials["read"]>
      try {
        stored = credentials.read(profile)
      } catch {
        // A locked or missing keyring must not hide the Himalaya entry.
        stored = undefined
      }
      if (stored) return { secret: stored.secret, source: stored.source === "environment" ? "environment" : "keyring" }
      const old = await (himalaya ?? secretToolLookup)(profile)
      return old ? { secret: old, source: "himalaya" } : undefined
    },
    write: (secret: string): void => {
      try {
        credentials.write(profile, secret)
      } catch {
        throw new CliError(
          "configuration_error",
          "the OS keyring is not available (locked, or no secret service is running); the password was not stored",
        )
      }
    },
    /**
     * A run with moved folders holding the owner's own password, which it may use but never remove (WC-SECR-24).
     * Compared by value: the run's temporary entry, read first, may hold the same password.
     */
    usesOwnersSignIn: (): boolean => {
      if (!moved) return false
      try {
        const stored = credentials.read(profile)
        return stored?.source === "keyring" && keyring.get(IDENTITY.appName, profile) === stored.secret
      } catch {
        return false
      }
    },
    remove: (): boolean => {
      try {
        return credentials.remove(profile).length > 0
      } catch {
        return false
      }
    },
  }
}
