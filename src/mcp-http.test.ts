import { expect, it } from "vitest"
import { run } from "./program.js"

const started = (argv: string[], env?: NodeJS.ProcessEnv) => {
  const out: string[] = []
  const err: string[] = []
  const code = run(argv, {
    streams: { data: (text) => out.push(text), diagnostic: (text) => err.push(text) },
    tty: false,
    ...(env ? { env } : {}),
  })
  return { code, out, err }
}

it("refuses mcp serve --http without the tunnel's address", async () => {
  const one = started(["personal", "mcp", "serve", "--http", "--json"])
  expect(await one.code).not.toBe(0)
  expect(one.err.join("\n")).toContain("--public-url")
})

it("forgets every browser login on mcp revoke", async () => {
  const one = started(["personal", "mcp", "revoke", "--json"])
  expect(await one.code).toBe(0)
  expect(JSON.parse(one.out.join("")).item).toMatchObject({ revoked: true })
})

it("refuses mcp revoke under the read-only lock", async () => {
  const one = started(["personal", "mcp", "revoke", "--json"], { ...process.env, MAIL_READ_ONLY: "1" })
  expect(await one.code).toBe(5)
})

it("forgets the browser logins of every profile's server on mcp revoke --profiles all", async () => {
  const one = started(["mcp", "revoke", "--profiles", "all", "--json"])
  expect(await one.code).toBe(0)
  expect(JSON.parse(one.out.join("")).item).toMatchObject({ revoked: true, profiles: "all" })
})

it("reports a server that is not running on mcp server status, for one profile and for all", async () => {
  const one = started(["personal", "mcp", "server", "status", "--json"])
  expect(await one.code).toBe(0)
  expect(JSON.parse(one.out.join("")).item).toMatchObject({ profile: "personal", running: false })
  const all = started(["mcp", "server", "status", "--profiles", "all", "--json"])
  expect(await all.code).toBe(0)
  expect(JSON.parse(all.out.join("")).item).toMatchObject({ profiles: "all", running: false })
})

it("prints the agent's MCP entry on mcp config, with the profiles and permissions it was given", async () => {
  const one = started(["mcp", "config", "--profiles", "all", "--permission", "sync=deny", "--json"])
  expect(await one.code).toBe(0)
  expect(JSON.parse(one.out.join("")).item.config.mcpServers.mail.args).toEqual(
    expect.arrayContaining(["mcp", "serve", "--profiles", "all", "--permission", "sync=deny"]),
  )
})
