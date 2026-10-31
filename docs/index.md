# mail

`mail` is a WireCat command-line tool that reads a mailbox over IMAP into the shared store, for the terminal, for
scripts and for AI agents. It signs in with an app password kept in the OS keyring. It does not send mail.

Commands: `session` (start: create the profile, check and keep the app password; status; end; list),
`account check`, `folders list`, `sync` and `status` (how far a sync is), plus the commands every WireCat CLI
shares: `doctor`, `commands`, `config`, `skill`, `mcp`, `runs` and `upgrade`.
Start with [installation](installation.md), then [usage](usage.md). Before the first login, prepare the mailbox:
[the steps for each provider](providers.md).

## Search your mail

`mail` fills the shared store. [memo](https://github.com/WireCatLabs/cli-memo) searches and shows it:

```sh
memo search mail "invoice"
```

See [memo search](https://github.com/WireCatLabs/cli-memo/blob/main/docs/search.md) for the query words.
