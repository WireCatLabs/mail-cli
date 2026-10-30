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

### Fixed

- `sync` no longer stops for good on a message Yandex can never read. Yandex refuses the whole body FETCH with `NO [UNAVAILABLE]` when one of its messages is broken on its side; the batch is now read again one message at a time, and only that message is reported unreadable.

- `sync` on a server with no message ids (Yandex) lists only UID, flags, date and size and downloads each new message
  once, taking its id from the Message-ID, so ids already stored do not change and mail already stored is not read
  again. A header listing of 200 messages took 5 to 40 s there and often failed with `NO [UNAVAILABLE]`, so months of
  mail took hours. Rules and the bulk class are decided on the downloaded message, so a message a skip rule drops is
  downloaded once. A new UIDVALIDITY, changed rules or `--rescan` still list with headers. A quick run does not prove
  deletions or refresh flags of mail it skips; `--rescan` does. Needs `@wirecat/cli-core` with `quick` and `identify`.
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
