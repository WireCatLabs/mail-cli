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
mail ya session start --address me@example.com # new profile: finds the server, shows the steps, asks for the app password
mail ya session start                 # an existing profile: asks for the app password again (checked, kept in the keyring)
mail ya account check                 # logs in and lists what the server supports
mail ya folders list                  # folders with role and counts
mail ya sync --since-time 2026-10-01  # reads new mail into the shared store; stored mail is skipped
```

`session start` on a new profile must find the mail server. It looks in a built-in table (Yandex, Gmail, iCloud,
Mail.ru, Fastmail, Outlook). Then it looks at the domain's MX record. Then it asks Thunderbird's list of mail servers and the
domain's own settings file. If none knows the server, set it yourself with `--host`, `--port` and
`--security`, or name a provider from the table: `--provider yandex`.

At a terminal, `session start` asks for what is missing: the provider and the address. Without a terminal it asks
nothing. A missing `--address` or password is then an error, and it reads the password from `MAIL_PASSWORD`. The
profile is saved only after the server accepts the app password. Outlook accepts only OAuth for IMAP, so
`session start` refuses it for now. To change the server of an existing profile, use `config set` or a new profile
name.

`session start` takes the password from the terminal or from `MAIL_PASSWORD`. It never takes it from an option or a
URL. After the server accepts it, `mail` keeps it in the OS keyring. If the keyring fails, `mail` keeps it in a
private file and says so once on stderr. `--credential-storage file` chooses the file; we do not recommend it. If
`mail` has no password, it reads the one Himalaya left (`secret-tool`, service `himalaya`, account the profile
name). An existing Himalaya setup then needs no new password.

`sync` reads INBOX and the Sent folder; on Gmail it reads All Mail, since archived mail leaves INBOX. `--folder` or the
profile's `folders` setting names other folders. It reads the newest mail first. `--limit` caps the new mail of one
run. `--rescan` lists the whole window again. It saves text and headers only. It does not store attachments.

A big mailbox does not fit in one run. `sync` has a budget of requests to the server, set by its deadline: 15
minutes at a terminal, 45 seconds over MCP. `--timeout` changes the deadline. `--max-pages` lowers the budget. The
run saves what it read, then answers `state: partial` and gives the same command in `next`. Run it again to go on.
`mail <profile> status` shows how far the sync is.

Yandex gives no message id. For such a server, `sync` lists only each message's number, flags, date and size, and it
downloads each new message once. It skips stored mail by that number, so a rerun reads nothing twice. It does not
notice mail deleted on the server or changed flags on mail it skips. `--rescan` does both. It also moves a reply stored
by mail 0.1 into the thread of the first email it answers: run `mail <profile> sync --rescan --since-time <date>` once,
with a date as old as the stored mail, and `rethreaded` says how many it moved.

Sometimes the server cannot answer for one message (Yandex answers some with `NO [UNAVAILABLE]`). `sync` asks for it
again at the end of the run. If it still fails, `sync` counts it in `unreadable` and leaves it for the next run.

Sometimes the server closes the connection. `sync` waits 1, 3, then 10 seconds, with a small random change so many
runs do not retry together. It then reconnects. It checks that the server still numbers the folder's mail the same
way, and goes on from the failed request while the budget and the deadline allow. If it still fails, the answer
keeps the network error's own code as `cause_code`, and `mail runs show` has it.

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

The server offers every command. A command that writes writes only to the local store, never to the mailbox. The
profile's permissions decide what runs; see
[settings](configuration.md#permissions).

For ChatGPT and Claude in the browser,
`mail personal mcp serve --http --public-url https://laptop.example.ts.net` serves on `127.0.0.1` (port 8765, or
`--port`) behind your own tunnel. A browser app logs in with a one-time code that the command prints;
`mail personal mcp revoke` ends every login. `mail personal mcp server start` runs the same
server in the background, `mcp server status` shows its port, the login code and the apps logged in, and
`mcp server stop` ends it.

## Search your mail

`mail` fills the shared store. [memo](https://github.com/WireCatLabs/cli-memo) searches and shows what is in it:

```sh
memo search mail "invoice"
```

See [memo search](https://github.com/WireCatLabs/cli-memo/blob/main/docs/search.md) for the query words.
