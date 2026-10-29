# Use it

This page explains how a command is built, and how an agent uses the tool. Read it before your first command.

## The profile comes first

A profile is a name you choose for one account. It is the first word of every command that uses an account:

```sh
mail ya folders list
```

`MAIL_PROFILE=ya` does the same for one shell session. No profile is ever assumed, not even the only one: a
command without one stops with exit code 2 and lists the profiles on this computer.

## Connect a mailbox

First prepare the mailbox: turn on IMAP and make an app password. [Prepare the mailbox](providers.md) has the steps
for every provider, and `setup` and `session start` print them too.

```sh
mail setup ya@burobiz.ru             # shows the server and the steps, saves a profile, asks for the app password
mail ya session start                # asks for the app password again later (it is checked and kept in the keyring)
mail ya account check                # logs in and lists what the server supports
mail ya folders list                 # folders with role and counts
mail ya sync --since-time 2026-10-01 # reads new mail into the shared store; stored mail is skipped
```

`setup` looks the address up in a built-in table (Yandex, Gmail, iCloud, Mail.ru, Fastmail, Outlook), then the MX
record, then Thunderbird's ISPDB and the domain's own autoconfig file. Give `--host`, `--port` and `--security` to set
a server by hand, or `--provider yandex` (any name in the table) when discovery finds nothing; at a terminal `setup`
asks which provider instead. At a terminal `setup` also asks for the app password, checks the login and keeps it in
the keyring, so one command is enough. With `--yes`, `--json` or no terminal it asks nothing, saves the profile and
prints `next_command`: `mail ya session start`. Outlook accepts only OAuth for IMAP, so `setup` refuses to save it for now.

`session start` takes the password from the terminal, never from an option or a URL. It is stored only after the
server accepted it. When the keyring has none, `mail` reads the entry Himalaya left (`secret-tool` service
`himalaya`, account the profile name), so an existing setup needs no new password.

`sync` reads INBOX and the Sent folder unless `--folder` or the profile's `folders` says otherwise, newest first,
and takes `--limit` per run, and `--rescan` to list the whole window again. It saves text and headers only: attachments are not stored.

## Output for scripts

Every command except `mcp serve` on stdin and stdout takes `--json`, and prints one JSON value on stdout. Errors are JSON on stderr, with a code to branch
on. The [command reference](commands.md) lists the codes.

## Agents

`mail skill install` puts the tool's skill where Claude Code, Codex, Gemini CLI and OpenClaw look for it.
`mail skill install --for hermes` also adds that folder to Hermes Agent's own settings, so a bare `skill install`
leaves Hermes out. `mail personal mcp serve` serves the profile's commands over MCP, on stdin and stdout:

```sh
claude mcp add mail -- mail personal mcp serve
```

The server offers every command, the ones that write included. The profile's permissions decide what runs; see
[settings](configuration.md#permissions).

For ChatGPT and Claude in the browser,
`mail personal mcp serve --http --public-url https://laptop.example.ts.net` serves on `127.0.0.1` (port 8765, or
`--port`) behind your own tunnel. A browser app logs in with a one-time code that the command prints;
`mail personal mcp revoke` ends every login. `mail personal mcp server start` runs the same
server in the background, `mcp server status` shows its port, the login code and the apps logged in, and
`mcp server stop` ends it.
