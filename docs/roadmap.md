# Roadmap

This page lists what is planned for `mail` and is not in it yet. Read it before you build a workaround for a
missing feature: it may already be on the way. The order is approximate and can change. To suggest something, open
an [issue on GitHub](https://github.com/WireCatLabs/mail-cli/issues).

## What works today

`mail` reads a mailbox over IMAP into the shared WireCat store, and organises it on the server: flags, moves,
copies, deletion to Trash and folders, each change one `messages restore` undoes. It keeps drafts on the server,
sends, replies and forwards over SMTP behind a recipient check and an hourly limit, and lists and downloads
attachments. It exports stored mail to mbox or Maildir, and a timer (`schedule`) can run any command. The owner's
mail rules and the envelope cleanup moved here from memo.

It finds the server of a new address by itself: a built-in table, the MX record, Thunderbird's ISPDB and the
domain's autoconfig file. It signs in with an app password kept in the OS keyring, which works for Yandex, Gmail,
iCloud, Mail.ru, Fastmail and other providers that offer app passwords. Outlook.com and Microsoft 365 sign in with
OAuth through WireCat's own Microsoft app, with nothing to register ([guide](outlook.md)); Gmail can use OAuth with
your own Google app ([steps](oauth-google.md)).

It searches and reads the stored mail of a profile (`search messages`, `messages show`, `conversations`) and asks
the mail server for mail `sync` has not read yet. `memo` searches every mailbox together with messages and notes. An
MCP server gives AI agents the same commands, and an agent can mail only the owner. Every command is in the
[command reference](commands.md).

## Next

- **Microsoft publisher verification**, which puts a verified badge on the consent page and which some
  organisations require before they allow the app. Waiting until users with work accounts appear.
- **A live test of Gmail over OAuth.** The sign-in is built, and has not yet been tried on a real Google account.

## Not planned

JMAP, Sieve filters on the server and PGP or S/MIME. If you need one, open an issue and say why.

What each released version changed is in the [changelog](../CHANGELOG.md).
