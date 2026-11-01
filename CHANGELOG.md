# Changelog

Notable changes to `@wirecat/mail-cli`. One section per version, newest first.

## Unreleased

### Added

- **`mail <profile> schedule`** runs a mail command on a timer through systemd, launchd or Task Scheduler, as `tg`
  does: `mail ya schedule command mail-ya --every 5m -- sync`. `doctor` says when a scheduled run keeps failing.

## 0.2.0 — 01.11.2026

### Added

- **The skill on ClawHub names its program and npm package**, so an OpenClaw user is told to install `@wirecat/mail-cli`
  before the skill works, as with the other WireCat skills.
- **mail's MCP server is listed in the official MCP Registry** as `dev.wirecat/mail-cli`.
- **`session start` prints the server it found before it sends the password**: host, port, security and login, so
  a wrong guess of discovery is seen before the password goes to it.
- **A new profile saves how it signs in (`auth`).** A profile saved before keeps working with its `imap_*` settings and
  signs in with an app password, with nothing to migrate.

### Changed — may break callers

- **`sync` reads All Mail on Gmail when the profile names no folders.** Archived Gmail mail leaves INBOX, so a sync of
  INBOX alone took it for deleted. All Mail is found by its role, so a Gmail account in another language works too.
- **Headers are read as memo reads them.** A mailing list's `List-Id` is stored without its angle
  brackets and in lower case, and Reply-To, Gmail's SPF, DKIM and DMARC verdicts and the attachment hint are read at
  list time, so the owner's rules see the same fields in both tools.

### Fixed

- **`sync` applies the account's stored mail rules, as memo does.** A skip or envelope rule decided in memo now holds
  for `mail sync` too, and both tools keep the same saved position, which holds a fingerprint of the rules. A Gmail
  profile syncs in Gmail mode, as memo does.
- **Gmail labels are named as memo names them** (`Inbox`, `Sent`, `Starred`, decoded names), so stored `label:Inbox`
  mailboxes keep matching and nothing is stored as `label:\Inbox`.
- **`sync --rescan` moves replies stored by 0.1 into their thread** on a server without thread ids, such as Yandex.
  The answer says how many in `rethreaded`. Gmail's threads are not touched.
- **A reply is stored in its conversation on servers without thread ids, such as Yandex and Mail.ru.** The thread is
  the first email named in References, else in In-Reply-To. Mail stored before moves with `sync --rescan`
  (above). Gmail keeps its own ids.
- **Every command that asks the server is bound by the run's deadline and Ctrl-C.** `session start` and
  `session status --check` opened the mailbox on their own, without the deadline or the abort the other commands
  had, and a source could reconnect after it was closed.
- **`sync` asks for at most 20 MB of message bodies in one request**, as well as at most 15 messages, so a batch of
  large attachments does not hold a connection for minutes or fill memory.
- **The schemas of `account check` and `session status` name `file` as a password source.** A password kept in the
  private file was answered as `file` while the published schema allowed only `environment`, `keyring` and
  `himalaya`, so a client that checks answers against the schema refused it.
- **A `sync` that `--limit` stopped says so.** It answers `stopped: "limit"` and how many new emails it left in
  `remaining`, and its next step says the run saved the emails `--limit` allows, instead of saying it stopped to
  answer in time.

## 0.1.1 — 01.11.2026

### Fixed

- **The docs take you from `sync` to a first found email, and say how the password is really kept.** Installation,
  usage and the docs index end with `memo search mail`, since `mail` fills the shared store and memo searches it. The
  password is kept in the keyring, falls back to a private file when the keyring fails, and can come from
  `MAIL_PASSWORD`; it is never read from stdin. `rate_limited` names both causes: the server limiting the account, and
  `sync` running out of its own request budget. The docs also say that `memo mail delete` moves Gmail mail to Trash.

## 0.1.0 — 31.10.2026

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
- **The app password falls back to a private file when the keyring fails, and is never asked about.** `session start`
  keeps the password in `credentials.json` (mode 600) in the config folder, says so once on stderr, and answers
  `credential_storage`. `--credential-storage file` chooses the file outright, not recommended. `session status` can
  answer `password_from: "file"`.
- **A run with moved folders never removes the owner's app password from the OS keyring.** Such a run reads the owner's
  password but never replaces or removes it, and stores a new one in a temporary entry. `session end` on the owner's
  password removes nothing and answers `kept: "owners-sign-in"`.
- **`wcat mail` runs the tool, and `wcat --help` lists it.** The package installs `wcat-mail` beside `mail`, and
  `wcat-mail --wcat-describe` prints the tool's name, version and description for `wcat`.
- **`doctor --online` says whether a newer version is published.** It makes no call to the mail server.
- **The commands every WireCat tool shares:** `doctor`, `commands`, `config`, `skill`, `runs` and `upgrade`.
