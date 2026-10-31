# Changelog

Notable changes to `@wirecat/mail-cli`. One section per version, newest first.

## Unreleased

### Added

- Started from `@wirecat/cli-template` 0.9.0.
- `session start|status|end` (WC-ACCT-12): `session start` signs a profile in. A new profile takes `--address` (or asks
  for it at a terminal), finds the IMAP server (built-in providers, MX record, ISPDB, autoconfig; `--provider`,
  `--host`, `--port`, `--security`, `--login`, `--folder` override), shows the steps to prepare the mailbox, asks for
  the app password with no echo (or reads `MAIL_PASSWORD`), checks it on the server and only then saves the profile and
  the keyring entry. Without a terminal it never asks and names the missing flag or variable. An existing Himalaya
  `secret-tool` entry is read when the keyring has none. A refused login names the likely cause. All providers:
  `docs/providers.md`.
- `account check`, `folders list` and `sync` (`--since-time`, `--limit`, `--max-pages`, `--folder`) over IMAP with imapflow, into the
  shared store.

### Changed — may break callers

- `mcp` and `doctor` are cli-core's shared commands (WC-CMD-25). `mcp serve`, `mcp revoke` and
  `mcp server start|stop|status` take `--profiles <names|all>`; `mcp serve` and `mcp server start` take
  `--permission <key=level>`, which only tightens; `mcp config`, `mcp add` and `mcp check` are new. Permission keys are
  command paths (`sync=deny`). `doctor` also reports the shared store's path and the profile lock.
- `mcp serve` over stdio no longer refuses `--json`.
- **The app password falls back to a private file when the keyring fails, and is never asked about.** `session start`
  used to fail with "the OS keyring is not available". Now it keeps the password in `credentials.json` (mode 600) in
  the config folder, says so once on stderr, and answers `credential_storage` (was `stored_in`).
  `--credential-storage file` chooses the file outright, not recommended. `session status` can answer
  `password_from: "file"`.
- `doctor --online` (cli-core 0.507.0) also connects once and reads the account, sending nothing; without the flag
  `doctor` connects to nothing, as before. Answers with a page may carry `page.total` (cli-base 0.67.0).
- The password file fallback now comes from cli-base 0.68.0 (`@wirecat/cli-base` 0.68.0, `@wirecat/cli-core`
  0.507.0): a password in the file is read from there, and `session start` that reaches the keyring removes the file
  copy. Answers are unchanged; the keyring warning still comes once per run.

### Fixed

- A run with moved folders can no longer remove the owner's app password from the OS keyring (cli-base 0.65.5). Only
  a run with `MAIL_*_DIR` counted as moved; a run with only `HOME` or an XDG folder moved used the real `mail-cli`
  entry, and `session end` there removed it. Such a run now reads the owner's password but never
  replaces or removes it, and stores a new one in a temporary entry. `session end` on the owner's password removes
  nothing and answers `kept: "owners-sign-in"`.
- `sync` no longer stops for good on a message Yandex can never read. Yandex refuses the whole body FETCH with
  `NO [UNAVAILABLE]` when one of its messages is broken on its side; the batch is now read again one message at a
  time, and only that message is reported unreadable.
- `sync` on a server with no message ids (Yandex) lists only UID, flags, date and size and downloads each new message
  once, taking its id from the Message-ID, so ids already stored do not change and mail already stored is not read
  again. A header listing of 200 messages took 5 to 40 s there and often failed with `NO [UNAVAILABLE]`, so months of
  mail took hours. Rules and the bulk class are decided on the downloaded message, so a message a skip rule drops is
  downloaded once. A new UIDVALIDITY, changed rules or `--rescan` still list with headers. The first sync after this
  lists each folder once with headers to record where stored mail is; after that a quick run refreshes flags and proves
  deletions from the stored UIDs. Needs `@wirecat/cli-core` 0.488.0 or later.
- `sync` no longer fails with "database is locked" while another tool (memo's timer) writes the shared store at the same
  time; `@wirecat/cli-core` 0.485.0 waits for the write lock by trying every millisecond.
- A read that finds no mailbox selected on its connection (imapflow clears the selection when a SELECT fails and still
  calls the connection usable) closes it and goes on after the same wait and on a fresh connection as a dropped line,
  instead of ending the run with `provider_error`.
- `sync` spends a request budget sized to its deadline (15 minutes at a terminal, 45 seconds over MCP) and answers
  `state: partial` with `next` when it stops early; mid-folder progress is saved after every part, so a large folder
  finishes over several runs. `--max-pages` lowers the budget; `mail <profile> status` shows how far a sync is.
- A message the server answers with `NO [UNAVAILABLE]` no longer fails the batch: it is asked for once more at the end
  of the run, counted in `unreadable` if it still fails, and left for the next run (never stored as done).
- A call to the server reads 15 messages on each of 4 connections (60 per request of the budget, `requestMs` 9 s), the
  numbers measured on Yandex 360 (cli-testing, `performance/mail/yandex-imap-sync`). `mail <profile> status` answers while a
  sync runs.
- A connection the server closes (or closes right after it opened) is reopened after a jittered 1, 3 and 10 second wait, UIDVALIDITY is checked again and
  the run goes on from the failed request, within the budget and the deadline. Each command also has its own 90 second
  limit. The transport's own code (`NoConnection`, `RequestTimeout`, `ETIMEDOUT`; never the server's text) is kept as
  `cause_code` and shows in `runs show`.
