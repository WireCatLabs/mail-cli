// Runs a dev command that starts the built bin (`cli-dev lint`, `cli-dev audit`) with a home of its own: on 2026-11-28
// dev runs with the developer's home moved the owner's memo folders and opened the owner's store.
//   node --experimental-strip-types scripts/sandboxed.ts <command> [args…]
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const [command, ...args] = process.argv.slice(2)
if (!command) {
  console.error("usage: node --experimental-strip-types scripts/sandboxed.ts <command> [args…]")
  process.exit(2)
}
const home = mkdtempSync(join(tmpdir(), "mail-sandbox-"))
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(XDG_|MAIL_|WCAT_|MEMO_)/.test(name)))
const folders = (prefix: string) => ({
  [`${prefix}_CONFIG_DIR`]: join(home, prefix.toLowerCase(), "config"),
  [`${prefix}_STATE_DIR`]: join(home, prefix.toLowerCase(), "state"),
  [`${prefix}_CACHE_DIR`]: join(home, prefix.toLowerCase(), "cache"),
  [`${prefix}_NO_UPDATE_CHECK`]: "1",
})
const run = spawnSync(command, args, {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: {
    ...env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    ...folders("MAIL"),
    ...folders("WCAT"),
    ...folders("MEMO"),
    MESSAGING_STORE: join(home, "store.db"),
    // A throwaway HOME does not hide the keyring: D-Bus still reaches it.
    DBUS_SESSION_BUS_ADDRESS: "disabled:",
  },
})
rmSync(home, { recursive: true, force: true })
process.exit(run.status ?? 1)
