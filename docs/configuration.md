# Settings

Settings live in one file, `config.json`, in the folder `mail doctor` shows. Each profile has its own part,
and `defaults` apply to every profile. This page lists how to see and change them.

```sh
mail ya config show
mail ya config set limit 50
mail ya config unset limit
```

A profile made by `session start` also holds the mailbox: `address`, `login` (when it is not the address), `imap_host`,
`imap_port`, `imap_security` (`tls` or `starttls`), `auth` (`app-password`; a profile saved without it signs in with an
app password too) and `folders` (the folders `sync` reads). `smtp_host`, `smtp_port` and `smtp_security` name the
server `messages send` submits to; set them only for a provider the [built-in list](providers.md) does not know. The app password is not
a setting: it lives in the keyring, or in `MAIL_PASSWORD` for a run that has no keyring.

`config show` lists each setting and where it came from: the file, a variable or the default.

`config set` also lists settings for search, speech and embeddings (`embedding_*`, `speech_model`, `picture_search`
and others). Every WireCat CLI shares that list. `mail` ignores them.

## Permissions

`permissions` decides what a command may do for this profile: `allow`, `ask`, `readonly` or `deny`, per permission
key. Over MCP there is no one to ask, so `ask` lets the command run. `MAIL_READ_ONLY=1` refuses every write, whatever
the permissions say.

The key of a command is its path: `messages.move`, `folders.delete`. Built in, a change that can be undone goes ahead
(flags, moves, copies, folders made or renamed, drafts saved), and these ask: `messages.delete`, `folders.delete`,
`drafts.delete`, and `messages.bulk`, which every change of more than 20 messages or chosen by `--filter` passes as
well. At a terminal
`ask` is a y/N question; `--yes` answers it.

Sending has two keys. `messages.send` and `messages.forward` are the commands themselves and go ahead when the mail
goes only to you. Mail that reaches anyone else also passes `messages.send.others`, which asks by default; set it to
`allow` to send without the question, or `readonly` to let this profile mail only you. An agent over MCP, where
nobody can answer the question, mails only you until you set `messages.send.others` in the config yourself (`ask` or
`allow`); an `mcp serve --permission` cannot open it. Each recipient counts toward `sends_per_hour` (30 by default).

```sh
mail ya config set permissions.messages readonly      # no flag, move, deletion or send on this profile
mail ya config set permissions.messages.bulk deny     # one message at a time only
mail ya config set permissions.messages.send.others allow   # send to others without the question, agents too
```

Every attempt to change the mailbox or send goes into the profile's send journal with its key, the count and the
outcome, never a subject, an address or the text.

## Run records

A command that fails is kept as a run, for `mail runs list` and `runs show`. `record_input` decides whether a run
keeps the words you typed; it is `true` unless you set it to `false`. Secrets are masked either way; see
[Security](security.md).
