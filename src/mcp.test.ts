import { describeProgram } from "@wirecat/cli-base/commands"
import { changesAuthorityAt, fetchesOnlyAt } from "@wirecat/cli-core/cli"
import { toolsFromCommands } from "@wirecat/cli-core/mcp"
import { expect, it } from "vitest"
import { configuration } from "./config.js"
import { createProgram, run } from "./program.js"
import { mcpClient } from "./testing/mcp.js"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const structured = (result: unknown) => {
  if (!isRecord(result) || !isRecord(result.structuredContent))
    throw new Error("the tool answered without structured content")
  return result.structuredContent
}

it("offers search, read and write, and names the mail text as untrusted", async () => {
  const { client, close } = await mcpClient()
  try {
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual(["mail_read", "mail_tools_search", "mail_write"])
    expect(client.getInstructions()).toContain("sender names")
  } finally {
    expect(await close()).toBe(0)
  }
})

it("finds writes as well as reads", async () => {
  const { client, close } = await mcpClient()
  try {
    const found = structured(await client.callTool({ name: "mail_tools_search", arguments: {} }))
    expect(found.items).toContainEqual(expect.objectContaining({ writes: true }))
    expect(found.items).not.toContainEqual(expect.objectContaining({ command: expect.stringMatching(/^mcp\b/) }))
  } finally {
    expect(await close()).toBe(0)
  }
})

it("runs a command through the CLI and answers with its result", async () => {
  const { client, close } = await mcpClient()
  try {
    const answer = structured(await client.callTool({ name: "mail_read", arguments: { command: "doctor" } }))
    expect(answer.item).toMatchObject({ version: expect.any(String), profiles: [] })
  } finally {
    expect(await close()).toBe(0)
  }
})

it("mcp serve refuses a --permission that names no command", async () => {
  const err: string[] = []
  const code = await run(["personal", "mcp", "serve", "--permission", "nope.list=deny"], {
    tty: false,
    streams: { data: () => {}, diagnostic: (text) => err.push(text) },
  })
  expect(code).toBe(2)
  expect(err.join("")).toContain("nope.list")
})

it("pins the commands an agent can find, and whether each reads or writes", async () => {
  const program = createProgram()
  const tools = toolsFromCommands(describeProgram(program), {
    includeUnavailable: true,
    exclude: [["mcp"]],
    authority: changesAuthorityAt(program),
    fetchOnly: fetchesOnlyAt(program),
    permissions: configuration.permissions,
  })
  const catalogue = Object.fromEntries(tools.map((tool) => [tool.command, tool.writes ? "write" : "read"]))
  await expect(`${JSON.stringify(catalogue, null, 2)}\n`).toMatchFileSnapshot("../contracts/mcp-catalogue.json")
  expect(catalogue).not.toHaveProperty("session start")
})
