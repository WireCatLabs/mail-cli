import { CliError } from "@wirecat/cli-base"
import { annotate, describeProgram } from "@wirecat/cli-base/commands"
import {
  changesAuthorityAt,
  environmentOf,
  type GlobalFlags,
  httpTokenFile,
  itemOf,
  LOCAL_READ,
  LOCAL_WRITE,
  MCP_HTTP_DEFAULT_PORT,
  mcpServerCommand,
  outputFor,
  REMOTE_WRITE,
  refuseUnderReadOnly,
  renderAnswer,
  rootOf,
} from "@wirecat/cli-core/cli"
import { Command } from "commander"
import { configuration } from "../config.js"
import { IDENTITY } from "../identity.js"

interface McpFlags extends GlobalFlags {
  http?: boolean
  port?: string
  publicUrl?: string
}

const SETUP = `claude mcp add ${IDENTITY.command} -- ${IDENTITY.command} personal mcp serve`

const settingsOf = (command: Command) => {
  const flags = command.optsWithGlobals<McpFlags>()
  const env = environmentOf(command).env ?? process.env
  const { profile } = configuration.resolveSettings(flags, { env })
  return { flags, env, profile, tokenFile: httpTokenFile(IDENTITY, profile, env) }
}

const serveCommand = (): Command =>
  annotate(new Command("serve"), {
    effects: REMOTE_WRITE,
    lifetime: "persistent",
    mcp: false,
    examples: [
      `${IDENTITY.command} personal mcp serve`,
      `${IDENTITY.command} personal mcp serve --http --public-url https://laptop.example.ts.net`,
    ],
  })
    .summary("serve this profile's commands to an AI agent")
    .description(
      `serve this profile's commands to an agent over MCP, on stdin and stdout, writes included; the profile's permissions decide — \`${SETUP}\``,
    )
    .option(
      "--http",
      "serve over HTTP on 127.0.0.1 for ChatGPT and Claude in the browser, behind your tunnel; the profile's permissions decide",
    )
    .option("--port <port>", `the local port for --http (default ${MCP_HTTP_DEFAULT_PORT})`)
    .option("--public-url <url>", "the tunnel's https address the browser apps use, e.g. https://<name>.ts.net")
    .action(async function (this: Command) {
      const { flags, env, profile, tokenFile } = settingsOf(this)
      if (!flags.http && (flags.json || flags.jsonl))
        throw new CliError("validation_error", "MCP over stdio controls its own output; leave out --json and --jsonl")
      const environment = environmentOf(this)
      const run = environment.runCommand
      if (!run) throw new Error("mcp serve runs inside the program's run(), which provides runCommand")
      const program = rootOf(this)
      const options = {
        profile,
        commands: describeProgram(program),
        levels: () => configuration.resolveSettings(flags, { env }).permissions,
        authority: changesAuthorityAt(program),
        run,
        ...(environment.signal ? { signal: environment.signal } : {}),
      }
      // Loaded here, not at the top: every other command would otherwise pay for the MCP SDK.
      const { serveMcp, serveMcpOverHttp } = await import("../mcp.js")
      if (!flags.http) return serveMcp(options)
      const { portOf, publicUrlOf } = await import("@wirecat/cli-core/mcp")
      const { renderer } = outputFor(this)
      await serveMcpOverHttp(options, {
        publicUrl: publicUrlOf(flags.publicUrl, {
          missing: "--http",
          reaches: `the browser apps reach ${IDENTITY.command}`,
        }),
        port: portOf(flags.port, MCP_HTTP_DEFAULT_PORT),
        tokenFile,
        background: env[`${IDENTITY.envPrefix}_MCP_HTTP`] !== undefined,
        note: (line) => renderer.note(line),
      })
    })

const revokeCommand = (): Command =>
  annotate(new Command("revoke"), {
    effects: LOCAL_WRITE,
    mcp: false,
    examples: [`${IDENTITY.command} personal mcp revoke`],
  })
    .summary("forget every login given to a browser app")
    .description("forget every login `mcp serve --http` gave a browser app; each must log in again")
    .action(async function (this: Command) {
      refuseUnderReadOnly(this, "mcp revoke")
      const { profile, tokenFile } = settingsOf(this)
      const { revokeAll } = await import("@wirecat/cli-core/mcp")
      revokeAll(tokenFile)
      renderAnswer(this, outputFor(this), itemOf({ revoked: true, profile }))
    })

export const mcpCommand = (): Command =>
  annotate(new Command("mcp"), { effects: LOCAL_READ, mcp: false })
    .summary("serve this profile's commands to an AI agent")
    .description(`serve this profile's commands to an agent over MCP — \`${SETUP}\``)
    .addCommand(serveCommand())
    .addCommand(revokeCommand())
    .addCommand(
      mcpServerCommand({
        example: `${IDENTITY.command} personal`,
        target: (self) => {
          const { env, profile, tokenFile } = settingsOf(self)
          return {
            invocation: `${IDENTITY.command} ${profile}`,
            profile,
            envPrefix: IDENTITY.envPrefix,
            env,
            tokenFile,
            argv: [profile, "mcp", "serve", "--http"],
            version: IDENTITY.version,
          }
        },
        answer: (self, item, lines) => renderAnswer(self, outputFor(self), itemOf(item), () => lines.join("\n")),
      }),
    )
