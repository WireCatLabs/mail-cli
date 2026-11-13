import { openAppStore } from "@wirecat/cli-core/cli"
import type { MessageStore } from "@wirecat/cli-core/store"
import { IDENTITY } from "./identity.js"

export const PROVIDER = { name: "email", kind: "mail", aliases: [], command: IDENTITY.command } as const

/** The shared store, with the `email` provider entry written so every other CLI's search knows it (WC-ARCH-21). */
export const openMailStore = (env: NodeJS.ProcessEnv, { readOnly = false } = {}): Promise<MessageStore> =>
  openAppStore(env, { app: IDENTITY, provider: PROVIDER, readOnly })
