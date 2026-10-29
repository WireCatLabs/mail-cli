# Changelog

Notable changes to `@wirecat/mail-cli`. One section per version, newest first.

## Unreleased

### Added

- Started from `@wirecat/cli-template` 0.9.0.
- `setup <address>`: finds the IMAP server (built-in providers, MX record, ISPDB, autoconfig) and saves a profile
  after you confirm.
- `session start|status|end`: the app password typed with no echo, checked on the server and kept in the OS keyring;
  an existing Himalaya `secret-tool` entry is read when the keyring has none.
- `setup` asks for the app password right after the server (at a terminal), checks the login and keeps it in the
  keyring, so one command is enough; `--provider <name>` or a pick from the built-in list covers an address discovery
  cannot place. With `--yes` or `--json` nothing is asked and `next_command` names the step left.
- `setup` and `session start` print the steps to prepare the mailbox for each built-in provider (turn on IMAP, make an
  app password), `setup --json` has them in `prepare`, and a refused login names the likely cause. All providers:
  `docs/providers.md`.
- `account check`, `folders list` and `sync` (`--since-time`, `--limit`, `--folder`) over IMAP with imapflow, into the
  shared store.

### Fixed

- `sync` is no longer cut after 30 s: it stops at the 5 minute default of a long fetch, keeps what it stored, and a
  rerun resumes (`--timeout` sets another limit).
- A dropped IMAP connection is retried once on a fresh connection, and the raw error code (`cause_code`, never the
  server's text) is kept on `network_error` and `timeout` failures.
- Listing reads 50 messages per request and gives a slow server 10 minutes per request instead of 2; a dropped batch is
  retried on its own, and the run stops if UIDVALIDITY changed meanwhile.
