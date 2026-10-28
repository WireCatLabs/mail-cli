# Changelog

Notable changes to `@wirecat/mail-cli`. One section per version, newest first.

## Unreleased

### Added

- Started from `@wirecat/cli-template` 0.9.0.
- `setup <address>`: finds the IMAP server (built-in providers, MX record, ISPDB, autoconfig) and saves a profile
  after you confirm.
- `session start|status|end`: the app password typed with no echo, checked on the server and kept in the OS keyring;
  an existing Himalaya `secret-tool` entry is read when the keyring has none.
- `account check`, `folders list` and `sync` (`--since-time`, `--limit`, `--folder`) over IMAP with imapflow, into the
  shared store.
