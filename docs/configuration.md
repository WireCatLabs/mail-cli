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
app password too) and `folders` (the folders `sync` reads). The app password is not
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

```sh
mail ya config set permissions.messages readonly      # no flag, move or deletion on this profile
mail ya config set permissions.messages.bulk deny     # one message at a time only
```

Every attempt to change the mailbox goes into the profile's send journal with its key, the count and the outcome,
never a subject or an address.

## Run records

A command that fails is kept as a run, for `mail runs list` and `runs show`. `record_input` decides whether a run
keeps the words you typed; it is `true` unless you set it to `false`. Secrets are masked either way; see
[Security](security.md).
