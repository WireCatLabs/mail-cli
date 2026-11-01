# Changelog

Notable changes to `@wirecat/mail-cli`. One section per version, newest first.

## Unreleased

### Added

- **`mail <profile> messages export [query] --output <folder>`** writes the original messages of the stored mail that
  match a query to mbox files (one per folder, mboxrd) or a Maildir++ tree (`--format maildir`), for backup or for mu
  and notmuch. The store keeps text only, so each message is read from the server again. The folder is private (mode
  700, files 600); a folder with something in it is refused unless `--resume` goes on with an export or `--replace`
  writes over files of the same name. `--limit` and `--max-pages` bound a run, which also stops before its deadline;
  `--resume` skips what the folder holds and cuts back a half-written message.
- **`mail <profile> stats messages top --by sender|list|domain`** ranks the stored mail by sender, mailing list or
  sender domain, with unread counts and size.
- **`mail <profile> messages mark-read|mark-unread|star|unstar <ref…>`** and **`messages update <ref…> --flag <flag>
  --unflag <flag> [--replace]`** change flags and keywords on the server (read, flagged, answered, draft, `$Junk`, words
  of your own); a folder that keeps no keywords answers `provider_unavailable`.
- **`messages move|copy <ref…> --folder <folder|role>`** files mail by folder; on Gmail a move is a label added and
  `Inbox` taken away, a copy a label added, `--folder archive` only `Inbox` taken away.
- **`messages delete <ref…>`** moves mail to Trash, never expunges it; `--rules` is memo's envelope cleanup, moved
  here: envelope mail the rules let go, each decided again, with Gmail's labels and stars read again just before the
  move, a fresh store backup required and a first run of at most 100.
- **`messages restore --run <id>`** undoes a change run, last step first: Trash back to where the mail was (on Gmail
  with its labels), moves back, copies removed, flags as they were. memo's `mail delete` run ids restore here too.
- **`folders create|rename|delete`**; `delete` refuses a folder that holds mail unless `--allow-dangerous`.
- **`rules list|add|remove|apply|export|import`**, moved from memo with the same options: the profile is the mailbox,
  so there is no account argument; the default import format is `mail`, the file memo's export writes.
- Every message write takes the messages by `ref` or by `--filter '<query>'` (`--limit`, newest first). A deletion,
  a `--filter` change and a change of more than 20 messages answer with a preview and the command with `--yes` in
  `next`; `--dry-run` only previews. The store follows each server change at once: flags, folder and UID, Gmail labels,
  deletion.
- **Permissions:** `messages.delete`, `folders.delete` and `messages.bulk` (any change of many) ask; the rest of the
  changes go ahead. `MAIL_READ_ONLY=1` refuses them all. Each attempt goes into the send journal (cli-core 0.522.0).
- Error reasons (`mail.no-trash`, `mail.run-unknown`, `mail.archive-unverified`, …) now reach the JSON error.
- **`mail <profile> drafts list|create|update|delete`** keeps drafts in the mailbox's own Drafts folder, so an agent
  writes one and the owner checks and sends it from any mail app. `create` takes `--to`, `--cc`, `--bcc`, `--subject`
  and the text (`-` reads stdin); `--reply-to <ref> [--reply-all]` answers a stored message in its thread. A draft is
  named by its Message-ID; `update` replaces only what is given and keeps the rest, the thread and the attachments;
  `delete` removes it for good and asks first (`drafts.delete`). Nothing is sent: `drafts send` comes with sending.
- **`mail <profile> tags add|remove <tag…> --message <ref> | --chat <ref>`** and **`tags list`** put your own tags on
  stored mail and conversations. They stay in the local store, in the same tables memo tags with, and never reach the
  server; `search messages tag:<tag>` finds them. Provider keywords stay `messages update --flag`, Gmail labels
  `messages move|copy --folder`.
- **`mail doctor`** says when a change run stopped part way, and when mail a run moved to Gmail's Trash is within five
  days of Gmail emptying it, with the `messages restore` command for each. memo's doctor said this until the cleanup
  moved here; memo's own cleanup runs count too. It needs cli-core 0.524.0 (`appDoctorCommand`'s `local` check).
- **`mail <profile> messages send --to … --subject … [text]`** sends over the provider's SMTP server with the same
  app password; the text comes from stdin when left out. `--cc`, `--bcc`, `--file <path>` (repeat; a named path, never
  a pattern; credential and WireCat folders refused without `--allow-any-file`). `--reply-to <ref> [--reply-all]`
  answers a stored email: `In-Reply-To`, `References`, `Re:`, the original quoted, `\Answered` set on it.
- **`messages forward <ref> --to … [text]`** sends the original attached whole (`message/rfc822`), `Fwd:` before its
  subject, and sets `$Forwarded` on it.
- **Sent and the store after a send.** Gmail files SMTP mail in Sent itself; elsewhere the copy (with its Bcc line) is
  appended to Sent unless Sent already holds that Message-ID. The message is then read into the store as `sync` reads it,
  so it has the server's id and never a second row.
- **Safety for sends.** Mail to anyone but the owner asks first: new key `messages.send.others`, default `ask`, which
  the owner may set to `allow`. The question shows from, to, cc, bcc, subject, each attachment and the first
  lines. `MAIL_READ_ONLY=1`, `readonly` and `deny` refuse; every attempt goes into the send journal without addresses,
  subject or text; each recipient counts toward `sends_per_hour`; sends are spaced with the shared request pace
  (cli-core 0.523.0). An answer lost after the message left is `outcome_unknown`; `--operation-id` retries it and sends
  nothing when Sent already has it. `--dry-run` builds the message and sends nothing. A text that says "attached" with
  no file warns.
- **`attachments list <ref>`** and **`attachments download <ref> [number…] --output-dir <dir> [--replace]`**: the
  files of one email, read from the server and numbered as the store numbers them, saved readable only by you under
  their plain names; an existing file is kept unless `--replace`.
- **Profile keys `smtp_host`, `smtp_port`, `smtp_security`** name the submission server for a provider the built-in
  list does not know. The built-in servers were checked against each provider's help page; Yandex's is now
  `smtp.yandex.ru:465`.

### Changed — may break callers

- `mail` is no longer read-only: an MCP client with `--allow-writes` can change the mailbox through the `write` tool,
  within the profile's permissions.

## 0.5.0 — 01.11.2026

### Fixed

- **A scheduled sync runs from its timer.** The timer starts `mail schedule exec <file>` with no profile, and mail refused it
  with "name a profile" before reading the schedule, so no timed run worked in 0.3.0 and 0.4.0. `schedule exec` now needs
  no profile; the schedule's own environment names it (cli-core 0.521.0).

## 0.4.0 — 01.11.2026

### Added

- **`mail <profile> search messages '<query>'`** searches the profile's stored mail offline, with the query language
  of every WireCat CLI and memo's ranking: any form of a word, `from:`, `to:`, `subject:`, `label:`, `is:unread`,
  `has:attachment`, `content:`, `date>7d`, and `list:` for a mailing list by its List-Id or domain. Mail from a
  suspicious sender comes after the rest (`--plain-order` keeps the words' order); `--newest`, `--exact`, `--page`.
- **`mail <profile> messages show <ref>`** gives one email whole, with the first 4,000 characters of each
  attachment's text (`--full`: all of it and the HTML body), and `--before-n`/`--after-n` emails of its thread, in the
  JSON `memo messages show` gives.
- **`mail <profile> conversations list [query]` and `conversations show <thread>`**: the threads, newest first,
  filtered by `subject:`, `emails_count>1` or `last_email_at>7d`, and one thread's emails oldest first.
- Each reads the profile's own mailbox only; a reference of another mailbox is refused. Over MCP they are `read`
  commands.

## 0.3.0 — 01.11.2026

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
