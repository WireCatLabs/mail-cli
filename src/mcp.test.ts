import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport } from "@modelcontextprotocol/server"
import { describeProgram } from "@wirecat/cli-base/commands"
import { changesAuthorityAt } from "@wirecat/cli-core/cli"
import { afterEach, expect, it } from "vitest"
import { configuration } from "./config.js"
import { createMcpServer, serveMcp } from "./mcp.js"
import { createProgram, run } from "./program.js"

const clients: Client[] = []
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close()
})

const connect = async () => {
  const program = createProgram()
  const server = createMcpServer({
    profile: "personal",
    commands: describeProgram(program),
    levels: () => configuration.resolveSettings({ profile: "personal" }).permissions,
    authority: changesAuthorityAt(program),
    run,
  })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(clientSide)
  clients.push(client)
  return client
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const structured = (result: unknown) => {
  if (!isRecord(result) || !isRecord(result.structuredContent))
    throw new Error("the tool answered without structured content")
  return result.structuredContent
}

it("offers search, read and write", async () => {
  const client = await connect()
  const { tools } = await client.listTools()
  expect(tools.map((tool) => tool.name).sort()).toEqual(["mail_read", "mail_tools_search", "mail_write"])
})

it("finds writes as well as reads", async () => {
  const client = await connect()
  const found = structured(await client.callTool({ name: "mail_tools_search", arguments: {} }))
  expect(found.items).toContainEqual(expect.objectContaining({ writes: true }))
  expect(found.items).not.toContainEqual(expect.objectContaining({ command: expect.stringMatching(/^mcp\b/) }))
})

it("runs a command through the CLI and answers with its result", async () => {
  const client = await connect()
  const answer = structured(await client.callTool({ name: "mail_read", arguments: { command: "doctor" } }))
  expect(answer.item).toMatchObject({ version: expect.any(String), profiles: [] })
})

it("serves until the command is stopped", async () => {
  const program = createProgram()
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const stop = new AbortController()
  const serving = serveMcp({
    profile: "personal",
    commands: describeProgram(program),
    levels: () => ({}),
    authority: () => false,
    run,
    signal: stop.signal,
    transport: serverSide,
  })
  const client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(clientSide)
  expect((await client.listTools()).tools).toHaveLength(3)
  stop.abort()
  await expect(serving).resolves.toBeUndefined()
})

it("mail <profile> mcp serve starts the server and ends on a signal", async () => {
  const stop = new AbortController()
  const serving = run(["personal", "mcp", "serve"], {
    signal: stop.signal,
    tty: false,
    streams: { data: () => {}, diagnostic: () => {} },
  })
  stop.abort()
  expect(await serving).toBe(0)
})
