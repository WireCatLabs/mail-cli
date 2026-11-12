const SHARED_MCP =
  "cli-core's appMcpCommand; its app-mcp-command and mcp-server-command tests drive it, and src/mcp.test.ts and " +
  "src/mcp-http.test.ts run mail's own server, config, revoke and refusals"
const LONG_RUNNING = `starts an HTTP server or a background process that runs until stopped; ${SHARED_MCP}`

const SHARED_SCHEDULE =
  "cli-core's scheduleCommandFor; its schedule.test.ts drives it, schedules.os.test.ts runs the timers on macOS and Windows CI, and src/program.test.ts adds and lists a mail schedule"

export const UNTESTED: { command: string; option?: string; reason: string }[] = [
  ...[{ command: "schedule pause" }, { command: "schedule resume" }].map((entry) => ({
    ...entry,
    reason: "cli-core src/cli/schedule/schedule.test.ts drives it through the shared schedule commands the CLI mounts",
  })),
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
  ...[
    { command: "schedule command", option: "--at" },
    { command: "schedule command", option: "--at-time" },
    { command: "schedule command", option: "--notify-on" },
    { command: "schedule command", option: "--deliver-to" },
    { command: "schedule agent" },
    { command: "schedule agent", option: "--max-cost" },
    { command: "schedule agent", option: "--every" },
    { command: "schedule agent", option: "--at" },
    { command: "schedule agent", option: "--at-time" },
    { command: "schedule run" },
    { command: "schedule remove" },
    { command: "schedule agents list" },
  ].map((entry) => ({ ...entry, reason: SHARED_SCHEDULE })),
  ...[
    { command: "doctor reports show" },
    { command: "doctor reports create" },
    { command: "doctor reports create", option: "--run" },
    { command: "doctor reports create", option: "--output" },
  ].map((entry) => ({
    ...entry,
    reason: "cli-core's appDoctorCommand; its app-mcp-command test creates and shows a report",
  })),
]
