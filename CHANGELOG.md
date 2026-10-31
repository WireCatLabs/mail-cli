# Changelog

Notable changes to `@wirecat/mail-cli`. One section per version, newest first.

## Unreleased

### Added

- **`mail` reads a mailbox over IMAP into the shared WireCat store, and never changes the mailbox.** `memo` and the
  other WireCat tools then search and read that mail on your computer. `mail` does not send mail.
- **`session start` signs a profile in with an app password.** A new profile takes `--address`, or asks for it at a
  terminal. It finds the server through a built-in table (Yandex, Gmail, iCloud, Mail.ru, Fastmail), the MX record,
  Thunderbird's ISPDB and the domain's autoconfig file; `--provider`, or `--host` with `--port` and `--security`, sets
  it by hand and skips those lookups. It shows the steps to prepare the mailbox, asks for the app password with no echo
  (or reads `MAIL_PASSWORD`), checks it on the server, and only then saves the profile and keeps the password in the
  OS keyring. Without a terminal it never asks and names the missing option or variable. An app password that
  Himalaya already keeps in the keyring is used when `mail` has none. The steps for every provider are on
  [Prepare the mailbox](https://github.com/WireCatLabs/mail-cli/blob/main/docs/providers.md). Outlook and Microsoft 365
  accept only OAuth, so `session start` refuses them for now.
- **`session status`, `session end` and `session list` manage the sign-in.** `session status --check` logs in to prove
  the password still works; `session end` forgets the password and keeps the synced mail; `session list` takes no
  profile and lists the profiles on this computer.
- **`account check` and `folders list`** log in and show what the server supports, and the folders with their role and
  message counts.
- **`sync` reads new mail into the shared store and skips what is already there.** It reads INBOX and Sent unless
  `--folder` or the profile names other folders, newest first, from `--since-time` (default: the last 30 days). A date
  alone starts at local midnight, and the answer gives the time zone and the window in UTC. `--limit` caps the new
  messages of one run and `--rescan` lists the whole window again. It saves text and headers, not attachments.
- **A big mailbox syncs over several runs.** `sync` spends a request budget sized to its deadline (15 minutes at a
  terminal, 45 seconds over MCP; `--timeout` and `--max-pages` change it), saves after each part and answers
  `state: partial` with the command to go on. `mail <profile> status` shows how far it is, also while a sync runs.
  When messages were left unread or deletions were not checked, the answer says so in `meta.issues`.
- **`sync` survives a flaky server.** A dropped connection is reopened after a short wait and the run goes on; a
  message the server cannot answer now is asked for again at the end of the run and left for the next one. On a server
  with no message ids, such as Yandex, each new message is downloaded once and stored mail is not read again.
- **AI agents use `mail` through MCP and a skill.** `mail <profile> mcp serve` offers the profile's commands to an
  agent over stdio, or over HTTP behind your own tunnel with `--http`; the profile's permissions decide what runs, and
  `--permission` only tightens them. `mail skill install` installs the tool's instructions for Claude Code, Codex,
  Gemini CLI and OpenClaw, and for Hermes with `--for hermes`.
- **The commands every WireCat tool shares:** `doctor`, `commands`, `config`, `skill`, `runs` and `upgrade`.
