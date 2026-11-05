# mail

`mail` is a WireCat command-line tool that reads a mailbox over IMAP into the shared store, for the terminal, for
scripts and for AI agents. It signs in with an app password kept in the OS keyring. It organises the mailbox on the
server, keeps drafts, and sends, replies and forwards over SMTP with the same app password.

Commands: `session` (start: create the profile, check and keep the app password; status; end; list),
`account check`, `folders list`, `sync` and `status` (how far a sync is), `review` (what is new, owed and waiting),
`search messages`, `messages show` and
`conversations list|show` (read what sync stored), `messages mark-read|move|copy|delete|restore|send|forward`,
`folders create|rename|delete`, `drafts`, `attachments`, `rules` and `tags`, plus the commands every WireCat CLI
shares: `doctor`, `commands`, `config`, `skill`, `mcp`, `runs` and `upgrade`.
Start with [installation](installation.md), then [usage](usage.md). Before the first login, prepare the mailbox:
[the steps for each provider](providers.md). For Outlook.com or Microsoft 365: [connect Outlook](outlook.md).

## Search your mail

`mail` searches the mail its profile synced, in the local store, and asks the mail server for mail `sync` has not
read yet. [Search your mail](usage.md#search-your-mail) shows the commands and the query language.
