# mail

`mail` is a WireCat command-line tool that reads a mailbox over IMAP into the shared store, for the terminal, for
scripts and for AI agents. It signs in with an app password kept in the OS keyring. It organises the mailbox on the
server, keeps drafts, and sends, replies and forwards over SMTP with the same app password.

Commands: `session` (start: create the profile, check and keep the app password; status; end; list),
`account check`, `folders list`, `sync` and `status` (how far a sync is), `search messages`, `messages show` and
`conversations list|show` (read what sync stored), `messages mark-read|move|copy|delete|restore|send|forward`,
`folders create|rename|delete`, `drafts`, `attachments`, `rules` and `tags`, plus the commands every WireCat CLI
shares: `doctor`, `commands`, `config`, `skill`, `mcp`, `runs` and `upgrade`.
Start with [installation](installation.md), then [usage](usage.md). Before the first login, prepare the mailbox:
[the steps for each provider](providers.md).

## Search your mail

`mail` searches and reads the mail its profile synced, in the local store, and asks the mail server for mail `sync`
has not read yet (`--backend archive` keeps to the store):

```sh
mail ya search messages invoice                                  # best match first, any form of the word
mail ya search messages 'from:ann@example.com has:attachment date>30d'
mail ya search messages 'list:github.com is:unread' --newest     # a mailing list, newest first
mail ya messages show '<ref from a search>'                      # the whole email and its attachments' text
mail ya conversations list emails_count>1                        # threads, newest first
mail ya conversations show '<chat:email/… ref>'                  # one thread, oldest first
```

The query language is the one every WireCat CLI uses ([search guide](https://github.com/WireCatLabs/cli-core/blob/main/docs/search/query-language.md)):
`from:`, `to:`, `cc:`, `subject:`, `mailbox:` or `label:`, `list:` (a List-Id or its domain), `is:unread`,
`has:attachment`, `filename:`, `content:` (the text of attachments), `size>` and `date:`. Each command reads its
profile's mailbox only; [memo](https://github.com/WireCatLabs/cli-memo) searches every mailbox together with your
messages and notes (`memo search mail`, `memo search all`). The store keeps text, not the original message, so there
is no raw source to show.
