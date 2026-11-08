import { resolvePaths } from "@wirecat/cli-base"
import { type AccountRemoval, accountRemoveCommand } from "@wirecat/cli-core/cli"
import { oauthAccount } from "@wirecat/cli-core/oauth"
import type { Command } from "commander"
import { configuration } from "../config.js"
import { IDENTITY } from "../identity.js"
import { runsDir } from "../mail/changes.js"
import { recordSignIn } from "../oauth.js"
import { oauthKeeperOf, oauthKindOf } from "./context.js"

const settingsOf = (env: NodeJS.ProcessEnv, profile: string) => configuration.resolveSettings({ profile }, { env })

const removal: AccountRemoval = {
  signOut: async (profile, { env, keyring, mayRevoke }) => {
    const settings = settingsOf(env, profile)
    const kind = settings.mailbox.auth === "oauth" ? oauthKindOf(settings.mailbox) : undefined
    if (!kind) return { revoked: null, removed: [] }
    // Only Google can be asked to revoke, and only for this profile's own grant: `--revoke` of `session end` ends
    // every sign-in of the Google project, which a removal of one account must not do.
    const { revoked } = await oauthKeeperOf(
      { environment: { ...(keyring ? { keyring } : {}) }, env, settings, profile },
      kind,
    ).signOut({
      revoke: mayRevoke && kind === "google",
    })
    await recordSignIn(env, profile, undefined)
    return {
      revoked: kind === "google" ? revoked : null,
      removed: [`the ${kind === "google" ? "Google" : "Microsoft"} sign-in`],
    }
  },
  account: (profile, { env }) => {
    const address = settingsOf(env, profile).mailbox.address
    return address ? { provider: "email", account: address } : undefined
  },
  secrets: (profile, { env, keyring }) => [
    {
      credentials: {
        configDir: resolvePaths({ appName: IDENTITY.appName, prefix: IDENTITY.envPrefix, env }).config,
        service: IDENTITY.appName,
        storage: "auto",
        env,
        ...(keyring ? { keyring } : {}),
      },
      accounts: [profile, oauthAccount("google", profile), oauthAccount("microsoft", profile)],
    },
  ],
  dataFiles: (profile, { env }) => {
    const address = settingsOf(env, profile).mailbox.address
    return address ? [runsDir(env, address)] : []
  },
}

export const removeCommand = (): Command =>
  accountRemoveCommand(IDENTITY, removal, { resolveSettings: configuration.resolveSettings })
