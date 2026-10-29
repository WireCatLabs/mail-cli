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
