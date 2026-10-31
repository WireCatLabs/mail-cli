# Roadmap

This page lists what is planned for `mail` and is not in it yet. Read it before you build a workaround for a
missing feature: it may already be on the way. The order is approximate and can change. To suggest something, open
an [issue on GitHub](https://github.com/WireCatLabs/mail-cli/issues).

## What works today

`mail` reads a mailbox over IMAP into the shared WireCat store and never changes the mailbox. It finds the server of
a new address by itself: a built-in table, the MX record, Thunderbird's ISPDB and the domain's autoconfig file. It
signs in with an app password kept in the OS keyring, which works for Yandex, Gmail, iCloud, Mail.ru, Fastmail and
other providers that offer app passwords. You search and read the stored mail through `memo`. An MCP server gives
AI agents the same commands. Every command is in the [command reference](commands.md).

## Next

- **OAuth sign-in for Outlook, Microsoft 365 and Google Workspace.** Microsoft accepts only OAuth for IMAP, so these
  mailboxes cannot be added yet, and a Workspace domain that turns app passwords off needs it too.

## Later

- **`--wcat-describe`**, a machine-readable description of the tool for WireCat's shared tooling. It needs cli-base
  0.66, and cli-core, which `mail` is built on, does not support that version yet.

What each released version changed is in the [changelog](../CHANGELOG.md).
