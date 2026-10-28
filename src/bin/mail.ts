#!/usr/bin/env node
import { enableCompileCache } from "node:module"
import { catchCrashes } from "@wirecat/cli-base"
import { IDENTITY } from "../identity.js"

enableCompileCache()
const stopCatching = catchCrashes({ cli: IDENTITY.command, interactive: process.stdout.isTTY === true })
const { run } = await import("../program.js")
try {
  process.exitCode = await run(process.argv.slice(2))
} finally {
  stopCatching()
}
