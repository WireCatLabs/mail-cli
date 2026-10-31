#!/usr/bin/env node
import { enableCompileCache } from "node:module"
import { catchCrashes } from "@wirecat/cli-base"
import { wcatStart } from "@wirecat/cli-base/wcat/start"
import { IDENTITY } from "../identity.js"

enableCompileCache()
const wcat = await wcatStart({
  command: IDENTITY.command,
  version: IDENTITY.version,
  description: IDENTITY.description,
  docs: "https://github.com/WireCatLabs/mail-cli#readme",
})
if (wcat.code !== undefined) {
  process.exitCode = wcat.code
} else {
  const stopCatching = catchCrashes({ cli: IDENTITY.command, interactive: process.stdout.isTTY === true })
  const { run } = await import("../program.js")
  try {
    process.exitCode = await run(process.argv.slice(2))
  } finally {
    stopCatching()
  }
}
