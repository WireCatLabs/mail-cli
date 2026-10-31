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
for every provider, and `session start` prints them too.

```sh
mail ya session start --address ya@burobiz.ru # new profile: finds the server, shows the steps, asks for the app password
mail ya session start                # an existing profile: asks for the app password again (checked, kept in the keyring)
mail ya account check                # logs in and lists what the server supports
mail ya folders list                 # folders with role and counts
mail ya sync --since-time 2026-10-01 # reads new mail into the shared store; stored mail is skipped
```

`session start` on a new profile looks the address up in a built-in table (Yandex, Gmail, iCloud, Mail.ru, Fastmail,
Outlook), then the MX record, then Thunderbird's ISPDB and the domain's own autoconfig file. Give `--host`, `--port`
and `--security` to set a server by hand, or `--provider yandex` (any name in the table) when discovery finds nothing;
at a terminal it asks which provider instead, and asks for the address when `--address` is missing. The profile is
saved only after the server accepted the app password. Without a terminal nothing is asked: a missing `--address` or
password is a validation error, and the password is read from `MAIL_PASSWORD`. Outlook accepts only OAuth for IMAP, so
`session start` refuses it for now. An existing profile only asks for its password again; to change its server, use
`config set` or a new profile name.

`session start` takes the password from the terminal or `MAIL_PASSWORD`, never from an option or a URL. It is stored only after the
server accepted it, in the keyring; where the keyring fails, in a private file, said once on stderr, never asked
(`--credential-storage file` chooses the file, not recommended). When neither has it, `mail` reads the entry Himalaya left (`secret-tool` service
`himalaya`, account the profile name), so an existing setup needs no new password.

`sync` reads INBOX and the Sent folder unless `--folder` or the profile's `folders` says otherwise, newest first,
and takes `--limit` per run, and `--rescan` to list the whole window again. It saves text and headers only: attachments are not stored.

A sync of a big mailbox does not fit one run. It spends a request budget sized to its deadline (15 minutes at a
terminal, 45 seconds over MCP; `--timeout` changes it, `--max-pages` lowers the budget), saves after each part and
answers `state: partial` with the same command in `next`; run it again to go on. `mail <profile> status` says how far it
is. On a server that gives no message id (Yandex) the listing is only UID, flags, date and size, and each new message
is downloaded once: stored mail is skipped by UID, so a rerun reads nothing again. Such a run does not notice mail deleted
at the server or changed flags on mail it skips; `--rescan` lists everything with headers and does both. A message the server fails on (Yandex answers some with `NO [UNAVAILABLE]`) is asked for once more at the end of
the run, and if it still fails it is counted in `unreadable` and left for the next run. When the server closes the
connection the sync reconnects after 1, 3 and 10 seconds (jittered), checks that UIDVALIDITY is the same and goes on from
the failed request, for as long as the budget and the deadline allow; a failure keeps the transport's own code as
`cause_code`, and `mail runs show` has it.

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
