# Use it

This page explains how a command is built, and how an agent uses the tool. Read it before your first command.

## The profile comes first

A profile is a name you choose for one account. It is the first word of every command that uses an account:

```sh
mail ya folders list
```

`MAIL_PROFILE=ya` does the same for one shell session. No profile is ever assumed, not even the only one: a
command without one stops with exit code 2 and lists the profiles on this computer.

## Connect a mailbox

First prepare the mailbox: turn on IMAP and make an app password. [Prepare the mailbox](providers.md) has the steps
for every provider, and `session start` prints them too.

```sh
mail ya session start --address me@example.com # new profile: finds the server, shows the steps, asks for the app password
mail ya session start                 # an existing profile: asks for the app password again (checked, kept in the keyring)
mail ya account check                 # logs in and lists what the server supports
mail ya folders list                  # folders with role and counts
mail ya sync --since-time 2026-10-01  # reads new mail into the shared store; stored mail is skipped
```

`session start` on a new profile must find the mail server. It looks in a built-in table (Yandex, Gmail, iCloud,
Mail.ru, Fastmail, Outlook). Then it looks at the domain's MX record. Then it asks Thunderbird's list of mail servers and the
domain's own settings file. If none knows the server, set it yourself with `--host`, `--port` and
`--security`, or name a provider from the table: `--provider yandex`.

At a terminal, `session start` asks for what is missing: the provider and the address. Without a terminal it asks
nothing. A missing `--address` or password is then an error, and it reads the password from `MAIL_PASSWORD`. The
profile is saved only after the server accepts the app password. Outlook accepts only OAuth for IMAP, so
`session start` refuses it for now. To change the server of an existing profile, use `config set` or a new profile
name.

`session start` takes the password from the terminal or from `MAIL_PASSWORD`. It never takes it from an option or a
URL. After the server accepts it, `mail` keeps it in the OS keyring. If the keyring fails, `mail` keeps it in a
private file and says so once on stderr. `--credential-storage file` chooses the file; we do not recommend it. If
`mail` has no password, it reads the one Himalaya left (`secret-tool`, service `himalaya`, account the profile
name). An existing Himalaya setup then needs no new password.

`sync` reads INBOX and the Sent folder; on Gmail it reads All Mail, since archived mail leaves INBOX. `--folder` or the
profile's `folders` setting names other folders. It reads the newest mail first. `--limit` caps the new mail of one
run. `--rescan` lists the whole window again. It saves text and headers, and the text of each attachment it can read, not the files. The
account's rules (`mail <profile> rules`, the same table memo reads) hold here too: mail a skip rule names is not read,
and an envelope rule keeps only its sender, date and size.

A big mailbox does not fit in one run. `sync` has a budget of requests to the server, set by its deadline: 15
minutes at a terminal, 45 seconds over MCP. `--timeout` changes the deadline. `--max-pages` lowers the budget. The
run saves what it read, then answers `state: partial` and gives the same command in `next`. Run it again to go on.
`mail <profile> status` shows how far the sync is.

To keep a profile current, put its sync on a timer (systemd, launchd or Task Scheduler):
`mail ya schedule command mail-ya --every 5m -- sync`. `mail ya schedule list` shows each schedule and how its last
run went, and `doctor` says when a run keeps failing.

Yandex gives no message id. For such a server, `sync` lists only each message's number, flags, date and size, and it
downloads each new message once. It skips stored mail by that number, so a rerun reads nothing twice. It does not
notice mail deleted on the server or changed flags on mail it skips. `--rescan` does both. It also moves a reply stored
by mail 0.1 into the thread of the first email it answers: run `mail <profile> sync --rescan --since-time <date>` once,
with a date as old as the stored mail, and `rethreaded` says how many it moved.

Sometimes the server cannot answer for one message (Yandex answers some with `NO [UNAVAILABLE]`). `sync` asks for it
again at the end of the run. If it still fails, `sync` counts it in `unreadable` and leaves it for the next run.

Sometimes the server closes the connection. `sync` waits 1, 3, then 10 seconds, with a small random change so many
runs do not retry together. It then reconnects. It checks that the server still numbers the folder's mail the same
way, and goes on from the failed request while the budget and the deadline allow. If it still fails, the answer
keeps the network error's own code as `cause_code`, and `mail runs show` has it.

## Output for scripts

Every command except `mcp serve` on stdin and stdout takes `--json`, and prints one JSON value on stdout. Errors are JSON on stderr, with a code to branch
on. The [command reference](commands.md) lists the codes.

## Agents

`mail skill install` puts the tool's skill where Claude Code, Codex, Gemini CLI and OpenClaw look for it.
`mail skill install --for hermes` also adds that folder to Hermes Agent's own settings, so a bare `skill install`
leaves Hermes out. `mail personal mcp serve` serves the profile's commands over MCP, on stdin and stdout:

```sh
claude mcp add mail -- mail personal mcp serve
```

The server offers every command. `sync` writes only to the local store; the `messages` and `folders` writes change
the mailbox. The profile's permissions decide what runs; see [settings](configuration.md#permissions).

For ChatGPT and Claude in the browser,
`mail personal mcp serve --http --public-url https://laptop.example.ts.net` serves on `127.0.0.1` (port 8765, or
`--port`) behind your own tunnel. A browser app logs in with a one-time code that the command prints;
`mail personal mcp revoke` ends every login. `mail personal mcp server start` runs the same
server in the background, `mcp server status` shows its port, the login code and the apps logged in, and
`mcp server stop` ends it.

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

`search messages` also asks the mail server, so mail sync has not read yet is found too: Gmail with its own search
over All Mail, other servers with IMAP SEARCH in INBOX, Sent and Archive (or the profile's `folders`). What the server
finds is stored and the same query decides, so each hit says `found_in`: `archive`, `server` (new from the server)
or `both`. `--backend archive` keeps to the store, `--backend server` answers only what the server found, and
`--server-time 20s` waits longer than the default 5 seconds. The server reads words, `from:`, `to:`, `cc:`,
`subject:`, `body:`, `is:` and `date:`; the rest of the query is applied to what it returns. IMAP SEARCH matches parts
of words and no other forms of a word, so a server can miss a hit that the store, with every form, finds after sync.
`permissions.messages.server-search=deny` in the profile turns the server search off.

Mail from a sender whose mail looks like spam or a scam comes after the rest of a page; `--plain-order` keeps the
order the words give. `messages show` gives the first 4,000 characters of each attachment's text; `--full` gives all
of it and the HTML body. `--before-n` and `--after-n` add the emails around it in its thread.

## Export mail

The store keeps text, not the original message, so `messages export` reads the originals from the server again.
It selects with the same query as `search messages` and writes a private folder (mode 700, files 600):

```sh
mail ya messages export 'from:ann@example.com' --output ~/mail-backup     # one mbox file per folder
mail ya messages export --folder INBOX --format maildir --output ~/Maildir # Maildir++, for mu and notmuch
mail ya messages export 'date>30d' --limit 500 --output ~/mail-backup --resume
mail ya stats messages top --by list --limit 10                          # which lists send the most
```

- **What is written.** Each message as the server holds it, byte for byte, in every folder it is filed in (Gmail files
  a message under All Mail and INBOX both: pass `--folder` to export one). mbox files are mboxrd: a body line that
  starts with the word From gets a `>` before it. Maildir file names carry the read (`S`) and starred (`F`) state.
- **Never over what is there.** A folder with something in it is refused. `--resume` goes on with an export begun
  there (a journal file, `.mail-export.jsonl`, lists what is done and the length of each mbox file after it); `--replace`
  writes into any folder over files of the same name and deletes nothing.
- **In parts.** A run stops at `--limit`, `--max-pages` or before its deadline and says `state: "partial"`; run it again
  with `--resume`. Mail the store has no UID for (sync again) or the server no longer has is counted, not written.

## Organise the mailbox

Every change goes to the server first and then into the store, so `search messages` shows it at once. The messages
are named by the `ref` a search gives, or chosen by `--filter` with the same query:

```sh
mail ya messages mark-read '<ref>'                               # also mark-unread, star, unstar
mail ya messages update '<ref>' --flag answered --unflag '$Junk'  # flags and keywords; --replace sets the whole set
mail ya messages move '<ref>' --folder archive                   # a folder by path, name or role
mail ya messages copy --filter 'list:github.com' --folder Lists --yes
mail ya messages delete --filter 'from:shop@example.com date<2025-01-01'   # a preview: nothing moves
mail ya messages delete --filter 'from:shop@example.com date<2025-01-01' --yes
mail ya messages restore --run '<run id the change answered with>' --yes
mail ya folders create Receipts                                  # also folders rename, folders delete
```

- **A preview first.** A deletion, a change chosen by `--filter`, and a change of more than 20 messages answer with
  what would change and the same command with `--yes` in `next`; nothing changes until then. `--dry-run` always only
  previews. One message's flag or move goes ahead at once.
- **Undo.** Each change answers with a `run` id. Before it asks the server, the run records each message's place,
  flags and Gmail labels; `messages restore --run <id>` puts back what is still where the run left it: Trash back to
  its folder, a move moved back, a copy removed, flags as they were. The runs of memo's old `mail delete` restore here
  too. Mail with text comes back to search with the next `sync`; an envelope at once.
- **Gmail.** All mail is in All Mail and a folder is a label: `move --folder Work` adds the label `Work` and takes
  `Inbox` away, `copy` only adds it, `--folder archive` only takes `Inbox` away, and `delete` moves the mail from All
  Mail to Trash with its labels kept in the run, so a restore puts them back.
- **Trash.** `delete` never expunges. It needs a Trash folder: the one the server marks `\Trash`, else the
  provider's own names (Yandex: «Удалённые»). A message already in Trash is counted as `in_trash` and left alone.
- **Rules.** `rules add --domain shop.example --do envelope` keeps only the envelope of that mail; `rules apply --yes`
  cuts mail already stored. `messages delete --rules` then moves envelope mail to Trash, each email decided again:
  it stays when a protect or keep rule matches, you replied to the sender, it is starred, important, sent or a draft,
  it carries a label of yours, or it is under 30 days old; Gmail's labels and stars are read again just before the
  move. It refuses until the store backup is under 8 days old, and a first run moves at most 100.
- **Folders.** `folders delete` is a preview until `--yes`, and refuses a folder that still holds mail, or whose
  count the server does not give; `--allow-dangerous` deletes it with its mail, for good (outside Gmail, the mail is
  gone). Only you pass `--allow-dangerous`, at a terminal: an agent over MCP never gets it. The inbox and the special
  folders keep their names.

## Drafts

A draft goes into the mailbox's own Drafts folder, so it shows in every mail app. An agent writes it; you read it and
send it from your mail app, or with `drafts send`.

```sh
mail ya drafts create --to anna@example.com --subject 'Monday' 'Shall we meet at ten?'
mail ya drafts create --reply-to '<ref>' --reply-all 'Thanks, agreed.'   # in the thread, to everyone but you
mail ya drafts create --to anna@example.com --subject Notes - < notes.txt # - reads the text from stdin
mail ya drafts list                                                       # newest first, read from the server
mail ya drafts update '<id>' 'New text'                                   # only what you give changes
mail ya drafts delete '<id>' --allow-dangerous                             # the owner's; gone for good, a preview without it
```

- **The id** is the draft's Message-ID, as `drafts list` shows it, with or without `<>`. It stays the same when the
  draft changes.
- **A reply** reads the message from the server: it goes to its Reply-To or sender (with `--reply-all` also to
  everyone else it went to, never to you), with `Re:` and the `In-Reply-To` and `References` that keep it in the thread.
- **A change** saves the new version first and then moves the old one to Trash, so a failure in between leaves two
  drafts, never none, and the old text can still be found. The text, `--to`, `--cc`, `--bcc` and `--subject` you give
  replace the old ones; the rest, the thread and the attachments stay. It needs a Trash folder.
- **Deleting** is for good, so `drafts delete` takes `--allow-dangerous`, which only the owner passes: `drafts delete` and `drafts send` remove the draft with UID EXPUNGE, which needs UIDPLUS
  on the server.
- **The folder** is the one the server marks `\Drafts`, else the provider's own name (Gmail «[Gmail]/Drafts», Yandex
  «Черновики»).
- A draft is flagged `\Draft` and `\Seen`. `drafts.delete` asks first; `drafts.create` and `drafts.update` go ahead,
  and `MAIL_READ_ONLY=1` refuses all three.

## Your own tags

Tags of your own go on stored mail and stay on this computer: the server never sees them. They are the same tags memo
reads, and a search finds them.

```sh
mail ya tags add invoices --message '<ref>'     # one email; --chat '<conversation ref>' tags a whole conversation
mail ya search messages 'tag:invoices date>30d'
mail ya tags list tag:invoices                  # what is tagged; type:message or type:chat
mail ya tags remove invoices --message '<ref>'
```

A tag is 1–32 letters a–z, digits and hyphens; upper case is lowered. What the server keeps instead are keywords
(`messages update --flag '$Work'`) and, on Gmail, labels (`messages move|copy --folder Work`).

## Send, reply and forward

`mail` sends over the provider's SMTP server with the profile's app password; the server comes from the
[provider list](providers.md), or from `smtp_host`, `smtp_port` and `smtp_security` in the profile.

```sh
mail ya messages send --to ann@example.com --subject Lunch "See you at noon."
echo "The report." | mail ya messages send --to ann@example.com --subject Report --file ./report.pdf
mail ya messages send --reply-to '<ref>' "Paid today."                # Re:, In-Reply-To, References, the quote
mail ya messages send --reply-to '<ref>' --reply-all "Thanks, all."   # also to the original's To and Cc, not you
mail ya messages forward '<ref>' --to bob@example.com "FYI"           # the original attached whole
mail ya messages send --to ann@example.com --subject Hi "Hello" --dry-run   # build it, send nothing
mail ya drafts send '<draft id>'                                     # send a saved draft, then remove it
```

- **The question.** Mail to anyone but you asks first, and shows from, to, cc, bcc, subject, each attachment and the
  first lines of the text; `--yes` answers it. With no terminal it answers `confirmation_required`.
  `config set permissions.messages.send.others allow` turns the question off. Mail only to yourself never asks.
- **Agents.** Over MCP an agent may mail, reply, forward and send drafts only to you; mail to anyone else answers
  `permission_error` until you set `messages.send.others` in the config.
- **Files.** `--file` takes a path as you name it; `mail` never expands a pattern. Credential folders (`.ssh`, keyrings,
  browser profiles) and the WireCat folders are refused unless `--allow-any-file`, which only you pass at a terminal:
  an agent over MCP never gets it. A text that says "attached" with no file draws a warning.
- **Sent.** Gmail files mail sent over SMTP in Sent itself. Elsewhere `mail` appends its copy, with the Bcc line, unless
  Sent already holds that Message-ID. The message is then read into the store, so `search messages` finds it at once.
- **A lost answer.** If the line breaks after the message left, the answer is `outcome_unknown` with an `operation_id`.
  Run the same command with `--operation-id <id>`: when Sent holds the message, nothing is sent again. On a provider
  that does not file sent mail itself the first try may still have gone; look in the recipient's mail before a retry.
- **Attachments.** `attachments list '<ref>'` numbers the files of one email; `attachments download '<ref>'
  --output-dir ./folder` saves them, readable only by you, under their plain names; `attachments download '<ref>' 2
  --output-dir ./folder` saves only the second. The bytes come from the
  server and never go into the store. An existing file stays unless `--replace`.
