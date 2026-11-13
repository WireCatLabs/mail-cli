import { syncAfterInstallCases } from "@wirecat/cli-core/testing"
import { describe, it } from "vitest"
import { harness, OLD, raw } from "./testing/mailbox.js"

describe("sync runs right after install, whatever the shared WireCat config holds", () => {
  for (const one of syncAfterInstallCases({
    sync: ["ya", "sync", "--since-time", "2026-01-01"],
    run: async (argv, env) => {
      const { mail } = await harness({
        folders: [{ name: "INBOX", messages: [{ uid: 1, raw: raw("a", "Hi", "x"), flags: [], date: OLD }] }],
      })
      return mail(argv, { env })
    },
  }))
    it(one.name, () => one.run())
})
