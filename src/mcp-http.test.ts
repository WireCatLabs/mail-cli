import { createServer } from "node:net"
import {
  Client,
  type OAuthClientInformationMixed,
  type OAuthClientProvider,
  type OAuthTokens,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client"
import { expect, it, vi } from "vitest"
import { run } from "./program.js"

const started = (argv: string[], signal?: AbortSignal, env?: NodeJS.ProcessEnv) => {
  const out: string[] = []
  const err: string[] = []
  const code = run(argv, {
    streams: { data: (text) => out.push(text), diagnostic: (text) => err.push(text) },
    tty: false,
    ...(signal ? { signal } : {}),
    ...(env ? { env } : {}),
  })
  return { code, out, err }
}

const answer = async (argv: string[]) => {
  const one = started(argv)
  expect(await one.code).toBe(0)
  return JSON.parse(one.out.join("")).item
}

const REDIRECT = "http://localhost/callback"

/** Logs in the way a browser app does: registers, types the terminal's code on the consent page, swaps it for tokens. */
const loggedInClient = async (base: URL, loginCode: () => string) => {
  const endpoint = new URL("/mcp", base)
  const saved: { info?: OAuthClientInformationMixed; tokens?: OAuthTokens; verifier?: string; consentAt?: URL } = {}
  const authProvider: OAuthClientProvider = {
    get redirectUrl() {
      return REDIRECT
    },
    get clientMetadata() {
      return {
        client_name: "Test app",
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }
    },
    clientInformation: () => saved.info,
    saveClientInformation: (info) => {
      saved.info = info
    },
    tokens: () => saved.tokens,
    saveTokens: (tokens) => {
      saved.tokens = tokens
    },
    redirectToAuthorization: (url) => {
      saved.consentAt = url
    },
    saveCodeVerifier: (verifier) => {
      saved.verifier = verifier
    },
    codeVerifier: () => saved.verifier ?? "",
  }
  const first = new StreamableHTTPClientTransport(endpoint, { authProvider })
  try {
    await new Client({ name: "test", version: "1" }).connect(first)
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error
  }
  if (!saved.consentAt) throw new Error("the server did not ask the client to log in")
  const typed = new URLSearchParams(saved.consentAt.searchParams)
  typed.set("login_code", loginCode())
  const answer = await fetch(new URL("/authorize", base), { method: "POST", body: typed, redirect: "manual" })
  const location = answer.headers.get("location")
  if (answer.status !== 302 || !location) throw new Error(`consent refused: ${answer.status}`)
  await first.finishAuth(new URL(location).searchParams.get("code") ?? "")
  const client = new Client({ name: "test", version: "1" })
  await client.connect(new StreamableHTTPClientTransport(endpoint, { authProvider }))
  return client
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      probe.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))))
    })
  })

it("serves the three tools behind the browser login, and shows the server in mcp server status until it stops, and frees the lock when it stops", async () => {
  const port = await freePort()
  const base = new URL(`http://127.0.0.1:${port}`)
  const stop = new AbortController()
  const serving = started(
    ["personal", "mcp", "serve", "--http", "--public-url", base.href, "--port", String(port)],
    stop.signal,
  )
  await vi.waitFor(() => expect(serving.err.join("\n")).toContain("serving on"))
  const codes = () => [...serving.err.join("\n").matchAll(/login code for a new browser app: (\S+)/g)].map((m) => m[1])
  const client = await loggedInClient(base, () => codes()[0] ?? "")
  try {
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      "mail_read",
      "mail_tools_search",
      "mail_write",
    ])
    expect(await answer(["personal", "mcp", "server", "status", "--json"])).toMatchObject({
      profile: "personal",
      running: true,
      port,
      connector_url: new URL("/mcp", base).href,
      login_code: { code: codes().at(-1) },
      clients: [expect.objectContaining({ claimed_name: "Test app" })],
    })
  } finally {
    await client.close()
    stop.abort()
    expect(await serving.code).toBe(0)
  }
  expect(await answer(["personal", "mcp", "server", "status", "--json"])).toMatchObject({ running: false })
})

it("refuses mcp serve --http without the tunnel's address", async () => {
  const one = started(["personal", "mcp", "serve", "--http", "--json"])
  expect(await one.code).not.toBe(0)
  expect(one.err.join("\n")).toContain("--public-url")
})

it("forgets every browser login on mcp revoke", async () => {
  expect(await answer(["personal", "mcp", "revoke", "--json"])).toEqual({ revoked: true, profile: "personal" })
})

it("keeps the login code out of a background server's log, and refuses a port in use", async () => {
  const port = await freePort()
  const url = `http://127.0.0.1:${port}`
  const stop = new AbortController()
  const background = started(
    ["personal", "mcp", "serve", "--http", "--public-url", url, "--port", String(port)],
    stop.signal,
    {
      ...process.env,
      MAIL_MCP_HTTP: "personal",
    },
  )
  try {
    await vi.waitFor(() => expect(background.err.join("\n")).toContain("serving on"))
    expect(background.err.join("\n")).toContain("a new login code for a browser app: `mail personal mcp server status`")
    const second = started(["work", "mcp", "serve", "--http", "--public-url", url, "--port", String(port), "--json"])
    expect(await second.code).not.toBe(0)
    expect(second.err.join("\n")).toContain(`port ${port} is in use`)
  } finally {
    stop.abort()
    await background.code
  }
})

it("refuses --json for MCP over stdio", async () => {
  const one = started(["personal", "mcp", "serve", "--json"])
  expect(await one.code).toBe(2)
  expect(one.err.join("\n")).toContain("MCP over stdio controls its own output")
})

it("refuses mcp revoke under the read-only lock", async () => {
  const one = started(["personal", "mcp", "revoke", "--json"], undefined, { ...process.env, MAIL_READ_ONLY: "1" })
  expect(await one.code).toBe(5)
})
