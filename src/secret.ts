import { execFile } from "node:child_process"
import { Credentials, isMovedRun, type KeyringStore, resolvePaths, systemKeyring } from "@wirecat/cli-base"
import { IDENTITY } from "./identity.js"

export type PasswordSource = "environment" | "keyring" | "file" | "himalaya"

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

/**
 * The app password of one profile: the keyring, or a private file when the keyring fails or the owner chose it
 * (WC-SECR-4). cli-base reads the file first, so a password kept there never waits on a locked keyring.
 */
export const passwordStore = ({ env, profile, keyring = systemKeyring, himalaya }: PasswordOptions) => {
  // cli-base gives a moved run a temporary entry only with the system keyring; this check must agree with it.
  const moved = keyring === systemKeyring && isMovedRun({ appName: IDENTITY.appName, prefix: IDENTITY.envPrefix, env })
  const options = {
    configDir: resolvePaths({ appName: IDENTITY.appName, prefix: IDENTITY.envPrefix, env }).config,
    service: IDENTITY.appName,
    isolated: moved,
    envVar: `${IDENTITY.envPrefix}_PASSWORD`,
    keyring,
    env,
  }
  const credentials = new Credentials(options)
  const file = new Credentials({ ...options, storage: "file" })
  const saved = () => credentials.read(profile)
  return {
    read: async (): Promise<{ secret: string; source: PasswordSource } | undefined> => {
      const found = saved()
      if (found) return found
      const old = await (himalaya ?? secretToolLookup)(profile)
      return old ? { secret: old, source: "himalaya" } : undefined
    },
    /** Where the password went; a password kept in the keyring drops a copy in the file. */
    write: (secret: string, storage: "keyring" | "file" = "keyring"): "keyring" | "file" => {
      if (storage === "file") {
        file.write(profile, secret)
        return "file"
      }
      const where = credentials.write(profile, secret, { signIn: true })
      return where === "keyring" ? "keyring" : "file"
    },
    /**
     * A run with moved folders holding the owner's own password, which it may use but never remove (WC-SECR-24).
     * Compared by value: the run's temporary entry, read first, may hold the same password.
     */
    usesOwnersSignIn: (): boolean => {
      if (!moved) return false
      try {
        const stored = saved()
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
