import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { packContents } from "@wirecat/cli-base/release"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isPackage = (value: unknown): value is { name: string; version: string; files: string[] } =>
  isRecord(value) &&
  typeof value.name === "string" &&
  typeof value.version === "string" &&
  Array.isArray(value.files) &&
  value.files.every((entry) => typeof entry === "string")

const root = resolve(import.meta.dirname, "..")
const pkg: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
assert.ok(isPackage(pkg), "package.json needs a name, a version and a files list")
const { name, version, files } = pkg
// npm reads `files` like .gitignore: a name with no leading slash also matches the same name in any folder.
const shipped = files
  .map((entry) => entry.replace(/^\//, ""))
  .map((entry) => (statSync(join(root, entry), { throwIfNoEntry: false })?.isDirectory() ? `${entry}/` : entry))
assert.deepEqual(packContents(root, ["package.json", ...shipped], "package.json and the paths in its files list")(), [])
const temp = mkdtempSync(join(tmpdir(), "mail-package-"))
try {
  const userConfig = join(temp, "npm-user-config")
  writeFileSync(userConfig, "")
  const npmEnv = { ...process.env, NPM_CONFIG_USERCONFIG: userConfig }
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temp], {
      cwd: root,
      encoding: "utf8",
      env: npmEnv,
    }),
  )
  assert.equal(packed.length, 1)
  const installed = join(temp, "installed")
  mkdirSync(installed)
  execFileSync(
    "npm",
    ["install", "--prefix", installed, "--ignore-scripts", "--no-audit", "--no-fund", join(temp, packed[0].filename)],
    { encoding: "utf8", env: npmEnv, stdio: "pipe" },
  )
  const env = {
    ...process.env,
    NODE_OPTIONS: "",
    HOME: temp,
    MAIL_CONFIG_DIR: join(temp, "config"),
    MAIL_STATE_DIR: join(temp, "state"),
    MAIL_CACHE_DIR: join(temp, "cache"),
    WIRECAT_STATE_DIR: join(temp, "wirecat"),
    MESSAGING_STORE: join(temp, "never-owner.db"),
    MAIL_NO_UPDATE_CHECK: "1",
    // A moved run still reads the owner's keyring entry; `disabled:`, since an unset variable falls back to the bus.
    DBUS_SESSION_BUS_ADDRESS: "disabled:",
  }
  const bin = join(installed, "node_modules", name, "dist/bin/mail.js")
  const run = (args: string[]) =>
    execFileSync(process.execPath, [bin, ...args], { cwd: temp, env, encoding: "utf8", timeout: 20000 })
  assert.equal(run(["--version"]).trim(), version)
  assert.deepEqual(JSON.parse(run(["--wcat-describe"])).name, "mail")
  assert.match(run(["--help"]), /Usage: mail/)
  const tree: unknown = JSON.parse(run(["commands", "--json"]))
  const names =
    isRecord(tree) && Array.isArray(tree.commands)
      ? tree.commands.map((command) => isRecord(command) && command.name)
      : []
  for (const root of ["commands", "doctor", "skill", "mcp", "upgrade", "config"])
    assert.ok(names.includes(root), `${root} is missing from the installed package`)
  assert.equal(JSON.parse(run(["doctor", "--json"])).item.version, version)
  assert.match(run(["skill", "show"]), /name: mail-cli/)
  console.log(`installed ${name}@${version}: help, version, commands, doctor and skill answer offline`)
} finally {
  rmSync(temp, { recursive: true, force: true })
}
