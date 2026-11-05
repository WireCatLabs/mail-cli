# Roadmap

This page lists what is planned for `mail` and is not in it yet. Read it before you build a workaround for a
missing feature: it may already be on the way. The order is approximate and can change. To suggest something, open
an [issue on GitHub](https://github.com/WireCatLabs/mail-cli/issues).

## What works today

`mail` reads a mailbox over IMAP into the shared WireCat store, and organises it on the server: flags, moves,
copies, deletion to Trash and folders, each change one `messages restore` undoes. It keeps drafts on the server,
sends, replies and forwards over SMTP behind a recipient check and an hourly limit, and lists and downloads
attachments. It exports stored mail to mbox or Maildir, and a timer (`schedule`) can run any command. It keeps the owner's
mail rules and runs the envelope cleanup.

`review` shows what is new since the last look, what you owe an answer (`--unanswered`) and what waits for one
(`--waiting`), and `--holder` gives each agent its own processing mark that `messages acknowledge` moves.
`stats messages show` counts stored mail received and sent per day, week or sender, and `stats messages top` lists
the senders, lists or domains with the most mail. `account inspect` groups a mailbox by sender and list before you
sync it, with a `skip` suggestion and a spam score. `messages import` adds a Google Takeout mbox file to a Gmail
profile. `sync` reads attachments up to a size you set (`read_attachments`, `max_attachment_mb`) and scores the
senders of the stored mail, so search ranks suspicious senders lower. `config migrate` and `config repair` keep the
settings file complete and valid.

A `schedule agent` runs on Sonnet by default, starts without your MCP servers, skills and settings, and starts no
run for the rest of the day once its runs cost 5 US dollars. `--model` and `--max-cost-per-day` change that for one
schedule, and the `schedule_model_claude`, `schedule_model_codex`, `schedule_lean_start` and
`schedule_max_cost_per_day` settings change it for every new one.

It finds the server of a new address by itself: a built-in table, the MX record, Thunderbird's ISPDB and the
domain's autoconfig file. It signs in with an app password kept in the OS keyring, which works for the
[providers](providers.md) that offer app passwords. Outlook.com and Microsoft 365 sign in with
OAuth through WireCat's own Microsoft app, with nothing to register ([guide](outlook.md)); Gmail can use OAuth with
WireCat's Google app or your own ([steps](oauth-google.md)).

It searches and reads the stored mail of a profile (`search messages`, `messages show`, `conversations`) and asks
the mail server for mail `sync` has not read yet. `memo` searches every mailbox together with messages and notes. An
MCP server gives AI agents the same commands, and an agent can mail only the owner. Every command is in the
[command reference](commands.md).

## Next

- **A live test of Gmail over OAuth.** The sign-in is built, and has not yet been tried on a real Google account.

## Not planned

JMAP, Sieve filters on the server and PGP or S/MIME. If you need one, open an issue and say why.

What each released version changed is in the [changelog](../CHANGELOG.md).
