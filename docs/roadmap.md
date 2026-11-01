# Roadmap

This page lists what is planned for `mail` and is not in it yet. Read it before you build a workaround for a
missing feature: it may already be on the way. The order is approximate and can change. To suggest something, open
an [issue on GitHub](https://github.com/WireCatLabs/mail-cli/issues).

## What works today

`mail` reads a mailbox over IMAP into the shared WireCat store, and organises it on the server: flags, moves,
copies, deletion to Trash and folders, each change one `messages restore` undoes. It keeps drafts on the server,
sends, replies and forwards over SMTP behind a recipient check and an hourly limit, and lists and downloads
attachments. The owner's mail rules and the
envelope cleanup moved here from memo. It finds the server of
a new address by itself: a built-in table, the MX record, Thunderbird's ISPDB and the domain's autoconfig file. It
signs in with an app password kept in the OS keyring, which works for Yandex, Gmail, iCloud, Mail.ru, Fastmail and
other providers that offer app passwords. It searches and reads the stored mail of a profile (`search messages`, `messages show`, `conversations`); `memo`
searches every mailbox together with messages and notes. An MCP server gives
AI agents the same commands. Every command is in the [command reference](commands.md).

## Next

- **OAuth sign-in for Gmail and Google Workspace** with your own Google app, for a domain that turns app passwords off.
  Outlook.com and Microsoft 365 sign in with OAuth already.

What each released version changed is in the [changelog](../CHANGELOG.md).
