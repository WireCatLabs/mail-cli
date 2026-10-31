const SHARED_MCP =
  "cli-core's appMcpCommand; its app-mcp-command and mcp-server-command tests drive it, and src/mcp.test.ts and " +
  "src/mcp-http.test.ts run mail's own server, config, revoke and refusals"
const LONG_RUNNING = `starts an HTTP server or a background process that runs until stopped; ${SHARED_MCP}`

export const UNTESTED: { command: string; option?: string; reason: string }[] = [
  {
    command: "doctor",
    option: "--online",
    reason: "connects to the mail server and npm; cli-core's app-mcp-command tests drive --online",
  },
  {
    command: "",
    option: "--help-all",
    reason: "Commander answers before any command runs, so the trace never sees it; contracts/help.snap covers help",
  },
  {
    command: "",
    option: "--version",
    reason: "Commander answers before any command runs, so the trace never sees it; `pnpm version:check` checks it",
  },
  ...[undefined, "--port", "--public-url", "--permission", "--profiles"].map((option) => ({
    command: "mcp server start",
    ...(option ? { option } : {}),
    reason: LONG_RUNNING,
  })),
  { command: "mcp server stop", reason: LONG_RUNNING },
  { command: "mcp server stop", option: "--profiles", reason: LONG_RUNNING },
  ...["--http", "--port", "--public-url", "--profiles"].map((option) => ({
    command: "mcp serve",
    option,
    reason: LONG_RUNNING,
  })),
  ...[undefined, "--allow-writes", "--permission"].map((option) => ({
    command: "mcp add",
    ...(option ? { option } : {}),
    reason: `writes Codex's or Claude Code's own MCP settings; ${SHARED_MCP}`,
  })),
  ...[undefined, "--permission"].map((option) => ({
    command: "mcp check",
    ...(option ? { option } : {}),
    reason: `starts the installed mail as a child process, as the agent would; ${SHARED_MCP}`,
  })),
]
