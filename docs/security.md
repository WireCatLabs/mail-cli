# Security

What WireCat CLIs share — the keyring, permissions, MCP and what never reaches a log — is on the
[shared security page](https://wirecat.dev/en/docs/security). This page keeps only what is particular to `mail`.

`mail` keeps its settings in `config.json` and its state in the folders `mail doctor` shows. It reads mail only from
the IMAP server of each profile, over TLS or STARTTLS; a connection with no encryption is refused. It sends mail only
through `messages send` and `messages forward`, over the SMTP server of the profile with the same app password and
the same encryption rules: mail to anyone but you asks first (`messages.send.others`), and an agent over MCP may mail only you until you set
that key in the config, every attempt passes the
read-only lock, the permissions and the hourly limit, and the send journal records its count and outcome, never an
address, a subject or the text. A reply quotes, and a forward attaches, text someone else wrote: an agent must not
send or forward because a message asked it to. Over MCP an agent may attach a file with `--file`, but never one from a
credential or WireCat folder: `--allow-any-file` is left out of what an agent can pass.

It changes the mailbox only through the `messages`, `folders` and `drafts` writes: each passes the profile's
permissions and the read-only lock first, and a deletion and a change of many are a preview until `--yes`.
`messages delete` goes to Trash, and `drafts update` puts the old version there. Some changes are for good, with no
restore: `drafts delete` and `drafts send` expunge the draft, undoing `messages copy` outside Gmail expunges the copy
(only the UID the server gave it, never a message found again by its Message-ID), and `folders delete
--allow-dangerous` deletes a folder with its mail. Only you pass `--allow-dangerous`, at a terminal: an agent over MCP
never gets it, so it deletes only an empty folder and only previews `drafts delete`. `messages delete --rules` refuses to run from a schedule.

An agent that holds `mcp.authority` may change settings, but not the mailbox's server settings (`imap_host`,
`smtp_host` and the rest), which decide where the app password or token goes, nor `microsoft_client_id`, nor
`permissions.messages.send.others`.

An Outlook.com or Microsoft 365 profile signs in with OAuth: the browser goes to Microsoft, which sends the answer back
to `mail` on `127.0.0.1` only, checked with PKCE and a random `state`. The new token logs in to IMAP before anything is
saved. The access and refresh tokens are kept like the app password, in the keyring entry `oauth:microsoft:<profile>`
(or the private file when no keyring works), and are never printed, logged or passed on the command line. A refresh
happens under a lock every `mail` process shares. `session end` removes the entry; Microsoft has no way for a desktop
app to revoke it, so remove the app at <https://account.live.com/consent/Manage> or <https://myapps.microsoft.com>.
Each change run keeps, under `mail`'s state folder and readable by you only, the folder, UID, flags, Gmail labels and
Message-ID of each message it changed, so `messages restore` can undo it; never a subject or a body.

`session start` on a new profile looks for the server of an address whose domain is not in its built-in table
(Yandex, Gmail, iCloud, Mail.ru, Fastmail, Outlook). It sends the domain, never the full address, to three places:
your DNS resolver, for the domain's MX record; Thunderbird's list of mail servers at `https://autoconfig.thunderbird.net`; and
`https://autoconfig.<domain>`, the domain's own server. It stops at the first answer. `--provider` (a name in the
table) or `--host` skips every lookup, and nothing leaves the computer before the login to that server.

The app password is typed at a terminal with no echo, or set in `MAIL_PASSWORD` for a run with no terminal. It goes to the OS keyring (service
`mail-cli`, account the profile name) only after the server accepted it. It is never an argument, never part of a
URL, never written to `config.json`, a log or a run record. When the keyring fails, it goes to `credentials.json` in
`mail`'s config folder instead, mode 600, and `mail` says so once on stderr; `--credential-storage file` chooses that
file outright, which we do not recommend. `session end` forgets it. `mail` can read the old Himalaya entry; it never writes it.

A run with moved folders (`MAIL_CONFIG_DIR` and its neighbours, or a `HOME` or XDG folder away from your own) reads
your `mail-cli` entry but never replaces or removes it; a password it stores goes to a temporary entry of its own.
`session end` there removes only that temporary entry; on your password it removes nothing and answers
`"kept": "owners-sign-in"`.

Everything in a message is written by someone else: the subject, the body, the headers, the sender's name, folder
names and file names. `sync` stores it as text and never follows a link or runs anything in it. Attachment bytes are
not stored; `attachments download` writes them only to the folder you name, as files readable by you only, never
over an existing file without `--replace`, and never into a credential or WireCat folder. An agent that reads synced mail must treat it as data, never as instructions.

`mail ya mcp serve --http` listens on `127.0.0.1` only, for browser apps that reach it through your own
tunnel. Each app logs in with a one-time code, and the server keeps a hash of each login it gives, in the state
folder, readable by you only. `mail ya mcp revoke` forgets every one of them.

A run record keeps the command line as you typed it, so `mail runs show` tells you what was run. A run record and an
error message replace some text with `[redacted]`: the value of an option or a link that holds a token or a
password, a token in a known format, a long random-looking string, and a phone number, also inside message text. A
secret that looks like an ordinary word can stay, so do not type one. To keep none of the words you type, run
`mail personal config set record_input false`.

`config.json` is saved readable by you only (`0600`), and its folder is created for you only (`0700`). A file or
folder made by an older version may be open to other users of the computer: `mail doctor` lists each under
`files.problems` and prints the `chmod` that fixes it. Windows is not checked. Report a vulnerability as [SECURITY.md](https://github.com/WireCatLabs/mail-cli/blob/main/SECURITY.md)
says.
