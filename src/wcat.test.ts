import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describeProgram } from "@wirecat/cli-base/commands"
import { buildManifest, MANIFEST_FILE, manifestText } from "@wirecat/cli-base/wcat/manifest"
import { wcatStart } from "@wirecat/cli-base/wcat/start"
import { describe, expect, it } from "vitest"
import { DESKTOP } from "./identity.js"
import { createProgram } from "./program.js"
import { WCAT } from "./wcat.js"

const MANIFEST = new URL(`../${MANIFEST_FILE}`, import.meta.url)

describe("contracts/wirecat.json", () => {
  it("is what pnpm generate builds from the command tree now", () => {
    const manifest = buildManifest({
      identity: WCAT,
      commands: describeProgram(createProgram()),
      pkg: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")),
      skills: true,
    })

    expect(readFileSync(MANIFEST, "utf8")).toBe(manifestText(manifest))
    const permissionOf = (path: string) =>
      manifest.commands.find((command) => command.path.join(" ") === path)?.permission
    expect(permissionOf("messages delete")).toBe("messages.delete")
    expect(permissionOf("schedule run")).toBe("schedule.run")
  })
})

describe("--wcat-describe", () => {
  it("answers with the shipped manifest's hosts and hash", async () => {
    const out: string[] = []
    const started = await wcatStart(DESKTOP, {
      argv: ["node", fileURLToPath(new URL("./bin/mail.ts", import.meta.url)), "--wcat-describe"],
      stdout: { write: (text: string) => out.push(text) },
    })

    expect(started.code).toBe(0)
    const answer = JSON.parse(out.join(""))
    expect(answer).toMatchObject({ name: "mail", desktop: { storage: { app: "mail-cli", env: "MAIL" } } })
    expect(answer.manifest_sha256).toBe(createHash("sha256").update(readFileSync(MANIFEST)).digest("hex"))
  })
})
