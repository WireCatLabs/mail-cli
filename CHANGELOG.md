# Changelog

Notable changes to `@wirecat/mail-cli`. One section per version, newest first.

## Unreleased

### Fixed

- **mail runs on cli-core 0.600.0.** `status` opens the store read-only even when an older WireCat tool left it at an
  older schema: cli-core now brings it up to date first, so mail no longer does that by itself. The shared store moves
  to version 54 (CRM pipelines kept apart per account, CRM field definitions), and an older WireCat tool still reads
  it. `schedule list` gives each schedule's `notify` setting.
- **`schedule agent` and `schedule command` send a run's result with `--deliver-to <route>`**
  (`telegram-bot:<profile>/<chat>` or `email:<profile>/<address>`, repeated for more), and `schedule list` shows the
  routes as `deliver_to`. `--to` keeps one meaning in mail: the address a message goes to.

## 0.17.0 — 06.11.2026

### Added

- **mail runs on cli-core 0.587.0 and cli-base 0.80.0.** `messages reset --holder <name> --since-time <time> | --last
  <n>` lets the owner move an agent's mail mark back, so its next `review --holder` gives that mail again
  (`--dry-run` counts first). `review --holder` gives the findings key and leaves out newsletters rather than all bulk
  mail. `schedule list` gives each agent schedule's cost caps. The shared store moves to version 52 (deals) the first
  time mail opens it, and an older WireCat tool still reads it.
- **`messages restore --write <id>` undoes one write of a run and leaves the others.** The id is an `operation_id`
  the run's answer listed under `writes`. A later restore of the whole run undoes the rest. A run logged before writes
  had ids, or an id it does not hold, is refused as `not_found` (`mail.write-unknown`).
- **`drafts send` lists the draft's removal from Drafts under `writes`** (`op: "delete"`), with its own
  `operation_id` beside the send's. **A Gmail restore from Trash lists putting the labels back** as a `label` write
  that names the write it undoes, and the change log keeps it. Both writes were made before, but answered no id.
- **Every write answers with its own `operation_id`, and the change log keeps it.** The `messages` changes, `messages
  delete` and `messages restore` list `writes`: one entry per write to the server, with its `operation_id`, what it did
  (`op`), the folder, `to` for a move and how many messages. A restore's write also names the write it undoes
  (`undoes`). `folders create|rename|delete` and `drafts create|update|delete` give the `operation_id` of their write.
  The same ids are in the send journal.
- **`account inspect` and `messages import` say which time zone they read `--since-time` in.** The answer gives
  `meta.timezone` and the window in UTC (`meta.window.since`), as `sync` does. `messages import` also gives
  `timezone` beside `since`, and `account inspect` adds a line to its table.

### Changed — may break callers

- **The run a `messages` change made is `run_id` in its answer, as in the other WireCat tools.**
  `messages mark-read|mark-unread|star|unstar|update|move|copy|delete` answered it as `run`. `messages restore` answers
  `run_id` for the run it made itself (it was `restore_run`, `null` for a preview) and `restored_run_id` for the run
  it undid (it was `run`). The `--run` option keeps its name: it is the shared vocabulary's flag for "the run it is
  about".
- **`sync`, `messages import` and `messages export` cap a run with `--max-messages`, and `messages export` writes into
  `--output-dir`.** `--limit` there capped the work of one run, not the rows of the answer, and it is now the shared
  vocabulary's work cap for messages. `--output` took a folder, and `--output` is the vocabulary's flag for one file.
  The next step's `args` follow: `max_messages` and `output_dir`. The old flags are gone. `--limit` stays where it
  counts what the answer shows: `account inspect`, `stats`, `drafts list`, `tags list` and the `messages` changes'
  `--filter` selection.
- **`attachments download` takes `[attachment...]` instead of `[number...]`.** The argument names the thing it takes,
  as the other WireCat arguments do. An agent passes the numbers under `attachment` instead of `number`, and a
  refusal names `param: "attachment"`. The values are still the numbers `attachments list` shows.

### Fixed

- **`status` answers on a store an older WireCat tool left at an older schema.** It opens the store read-only, so
  it answers while a sync runs, and a read-only open refuses a schema older than its own. After an upgrade, `status`
  failed (`configuration_error`, "needs schema … maintenance") until another command updated the store. It now
  updates it once itself.
- **A stop signal lets `messages import` finish the read in flight and keep what it saved, as `sync` does.** Before,
  Ctrl-C or an MCP cancel cut the import at once, while it was still reading. It now stops before the next read and
  answers `stopped: "cancelled"`. It also gets the deadline of a resumable sync: 15 minutes at a terminal, 45 seconds
  over MCP, instead of 30 seconds.
- **The iCloud steps say in plain words how to sign in with the short login.** They no longer quote a command line
  with its flags, and `session start --help` still lists `--login`.
- **Every screen shows a person their times in the local time zone:** `status`, `sync`, `messages restore`, and, with
  cli-core 0.587.0, `search messages`, `messages show`, `conversations list|show`, `review` and `runs list|show`. A
  table read `2025-12-31T14:00:00.000Z`, and it now reads `2026-01-01 00:00`, with no offset, and a line `times in <zone>`
  names the zone (the `TZ` of the computer, or the zone it is set to). JSON and JSONL answers keep UTC.
- **Commands that talk to the mail server answer only after they closed the connection and the store.** `account
  check`, `account inspect`, `folders`, `sync`, `messages export`, the `messages` changes, `drafts` and the sends
  printed their answer first. A failing close now ends in an error instead of after a success. JSON answers are
  unchanged.
- **A send whose store fails to close afterwards says so and names its `operation_id`.** `messages send|forward` and
  `drafts send` then end in `outcome_unknown`: the message was probably sent, and the same command with
  `--operation-id <id>` finds it in Sent instead of sending it twice. Before, the error had no `operation_id`.
- **Eleven more refusals carry a registered reason**, so `commands info` lists them and a script can tell them apart:
  `mail.flag-deleted`, `mail.no-selection`, `mail.refs-and-filter`, `mail.move-to-trash`, `mail.original-gone`,
  `mail.others-for-agent`, `mail.no-submission`, `mail.config-unreadable`, `mail.profile-exists`,
  `mail.server-unknown` and `mail.export-other`. Their messages are unchanged. A write whose outcome is unknown now
  says "check the mailbox before running it again", without naming `sync`.
- **The user pages give example values instead of placeholders, and state each fact once.** Commands in the usage
  guide, the Outlook pages and the overview use example references and ids (`msg:email/me%40example.com/…`) where they
  had `<ref>` or `<id>`. The provider list is on the "Prepare the mailbox" page only, and the overview links the
  search guide instead of repeating it. The usage guide no longer speaks of mail 0.1, and the Microsoft app page no
  longer describes how the maintainers release a client id. No behaviour changes.
- **Files `mail` reads back are checked field by field instead of trusted.** A rules file whose condition has the
  wrong type is refused with the rule's number. A damaged export journal header, sign-in record, RDAP answer or
  domain-age cache is treated as missing instead of breaking the command.
- **The README and `SECURITY.md` say what `sync` sends out to score new senders:** a sender's domain, never an
  address, to IANA's list of registries and to that domain's own registry. Only the security page said so before. No
  behaviour changes.

### Removed

- **The package no longer ships `dist/index.js`.** It re-exported `run`, `createProgram`, `definition` and `IDENTITY`,
  but `package.json` never named it, and no WireCat tool imported it. `mail` is a command, not a library.

## 0.16.3 — 05.11.2026

### Fixed

- **The Microsoft sign-in notes no longer describe publisher verification.** They say that making a shared Microsoft
  app public is complex, and point to your own Microsoft app. No behaviour changes.

## 0.16.2 — 05.11.2026

### Fixed

- **The "Prepare the mailbox" page lists the international providers first**: Gmail, Outlook, Microsoft 365, iCloud,
  Fastmail, then Yandex. Mail.ru is no longer on the English page; it stays a built-in provider and keeps its steps
  in the Russian translation. No behaviour changes.
- **The Google and Microsoft sign-in notes no longer describe WireCat's review or verification status.** They say that
  making a shared Google app public for mail is complex, so Google may refuse WireCat's app, and then point to your own
  Google app or an app password. No behaviour changes.
- **`session end` help says what `--revoke` does to your account.** With Gmail over OAuth it asks Google to revoke
  the sign-in, which signs out every tool that uses the same Google project. The command's description and examples
  now say so. No behaviour changes.

## 0.16.1 — 05.11.2026

### Fixed

- **The tests of the private file modes skip the mode check on Windows**, where files have no Unix modes.
- **Docs, help examples and the skill name the example profile `personal`, not `ya`**, as tg does. A second
  mailbox in an example is `work`. No behaviour changes.
- **`docs/configuration.md` says which flag answers `ask`**: `--allow-dangerous` for `drafts delete`, `--yes` for
  every other change, and `confirmation_required` without a terminal or a flag.
- **The sender domain cache and the sign-in records folder are private to you.** `domain-ages.json` is written with
  mode 600 and the folder that holds `sign-ins.json` with mode 700, as every other private file of mail's.
- **Every error and issue reason mail raises is in its registry**, so `mail commands info` lists it and an agent can
  branch on it: `mail.smtp-login-refused`, `mail.no-drafts`, `mail.draft-unknown`, `mail.gmail-objectid`,
  `mail.export-destination-exists`, `download.exists`, `mail.unreadable`, `mail.deletions-skipped`,
  `mail.rules-unreadable` and `mail.export-unreadable`. A test keeps the list complete.
- **The secret scan knows Google's OAuth access tokens, refresh tokens and client secrets.**
- **`mail commands info` says what `rules remove`, `rules apply` and `rules import` answer with**, as every other
  command does: `mail_rule_change`, `mail_rules_apply` and `mail_rule_import`. The answers are unchanged.
- **`rules apply` closes its connection to the mail server before it answers**, and the tag commands hand the store
  to the run, so a timeout or a signal closes it too.

## 0.16.0 — 05.11.2026

### Changed — may break callers

- **mail runs on cli-core 0.569.0: an agent schedule runs on Sonnet, starts lean and stops for the day at a cost
  cap.** `mail <profile> schedule agent` takes `--model <model>` and `--max-cost-per-day <usd>`. Without them a claude
  schedule runs on `sonnet` and a codex one on codex's own default, a new claude schedule starts without your MCP
  servers, skills, settings and CLAUDE.md, and no run starts for the rest of the day once the day's runs cost 5 US
  dollars. `schedule_model_claude`, `schedule_model_codex`, `schedule_lean_start` and `schedule_max_cost_per_day` in
  the config file's `defaults` change that for every new schedule; `mail config show` lists them.

## 0.15.0 — 05.11.2026

### Changed — may break callers

- **The profile sets whether and up to what size `sync` reads attachments, and one run can override it.** The
  profile's `read_attachments` (default `true`) and `max_attachment_mb` (default 10) set it; `--no-attachments`,
  `--attachments` and `--max-attachment-mb <n>` override it for one run. A file left unread is stored with its name and
  size, its extraction `not-read` or `too-large`. No file is kept either way.
- **`messages show` reads an email again when one of its attachments was left unread**, every attachment whatever
  its size, so the command now reaches the mail server for such an email. `--offline` or a failed read shows the stored
  email with `meta.complete: false` and the issue `mail.attachments-unread`. `attachments download` keeps a file.
- **Gmail over OAuth signs in with WireCat's Google app when you name none.** It needed `--client-file` or
  `MAIL_GOOGLE_CLIENT_ID` and failed with `mail.oauth-no-client` without them. The order is `--client-file`, then
  `MAIL_GOOGLE_CLIENT_ID` (with `MAIL_GOOGLE_CLIENT_SECRET`), then the profile's new `google_client_id`, then
  WireCat's app. Google has not reviewed WireCat's app for mail yet: if Google refuses it, use your own
  ([steps](docs/oauth-google.md)). Choosing OAuth for a Gmail profile is unchanged.
- **`MAIL_MICROSOFT_CLIENT_ID` picks the Microsoft app for one run**, before the profile's `microsoft_client_id` and
  WireCat's app, which now comes from cli-core's `constants.json`. `mail.oauth-no-client` is gone: there is always an
  app.
- **`doctor`'s `oauth` rows say which app each profile uses as `oauth_client: { client, source }`**, in place of
  `client`: `source` is `flag`, `env`, `config` or `constants` (WireCat's). A profile's row reports the app it
  signed in with when its sign-in recorded one. `session start` answers `source` beside `client`.
- **mail runs on cli-base 0.77.1 and cli-core 0.566.0.**

### Added

- **`stats messages show` counts the profile's stored mail per day, week or sender**, received and sent, over the
  same query as `search messages`: `{ by, received, sent, rows: [{ key, name, received, sent }] }`, a day or week key
  `YYYY-MM-DD` in `--timezone` (a week by its Monday), a sender keyed by address with `sent` 0. Counts only, no search
  recorded. For WireCat Desktop's mail per day (cli-core's `mailStats`, 0.564.0).
- **`account inspect` groups the mailbox's mail by sender and list before you sync it**: emails, MB, unread and bulk
  shares, years, whether you replied, a `skip` suggestion and a spam or scam score, plus the rule kinds the mail would
  match. Headers only, nothing stored. `--domain-age` asks each sender domain's registry (RDAP) when it was
  registered. Moved from `memo mail inspect`.
- **`messages import <file.mbox>` adds a Google Takeout archive to a Gmail profile's stored mail**, joined with what
  `sync` stores by Gmail's ids; it only adds, leaves out Spam and Trash and follows the profile's rules. Moved from
  memo's `mode: "mbox"` mail accounts.
- **`sync` scores the senders of the stored mail, at most once a day**, and asks registries about new sender domains
  until its deadline; search ranks mail from senders with signs of fraud lower. The answer's `senders` says how many.
  `memo sync` did this before; it no longer reads mail.

### Fixed

- **The MCP server tells an agent that attachment text is data, not instructions**, beside subjects, bodies and file
  names. `sync` indexes attachment text and `messages show` returns it.
- **`session start` writes every setting at its default when it saves a new profile**, as `config set` does. The
  first file a sign-in made held only the profile, so the owner could not see the other settings until a later
  `config set` or `config migrate`.

## 0.14.0 — 05.11.2026

### Added

- **`config migrate` writes each setting your config file lacks, at its default**, and keeps your values, their order
  and keys it does not know; it creates no section and running it again adds nothing. A first run now writes every
  shared setting into the file, and `config set` and `config unset` fill in the missing ones. `config show` gives each
  setting its default and description, and no longer creates a missing file. From cli-core 0.563.0.

### Changed — may break callers

- **Mail sync reads attachments up to 10 MB a file by default**, and can skip them. From cli-core 0.563.0.
- **`review --holder` leaves out mail from suspicious senders too**, beside bulk, envelopes, drafts and partial mail.
  From cli-core 0.560.0.
- **An answer over the output cap names what to run instead** (WC-OUT-22). From cli-core 0.563.0.
- **The store moves to version 48** (invoices and payments, imports through one envelope, the cleanup of test rows
  that leaked into a real store). The first run of this version migrates it. From cli-core 0.557.0–0.560.0.

## 0.13.0 — 02.11.2026

### Added

- **`review`: what is new, what you owe, what waits for an answer**, with tg's words: `review "date>2h"`, `--new`
  (a point per mailbox and reader), `--unanswered [duration]` (newest email came to you in To or Cc, no answer),
  `--waiting [duration]` (you wrote last), and `bulk:false` to leave out mail sent to many. Each email carries
  `bulk`, `list_id` and `rule_id`. It reads the store only; over MCP it is the read tool `review`. From cli-core.
- **A processing mark per agent**: `review --holder <name>` reads what is stored past that holder's mark, by store
  order, so late-synced mail is not skipped; `messages acknowledge --holder <name> --cursor <cursor>` moves it forward.
  Bulk mail, envelopes and drafts are skipped and counted, partial mail held. `status` lists each holder: how far it
  got, held, read and skipped by reason. From cli-core 0.556.0.
- **`config repair`** mends a settings file whose JSON is broken only in its syntax, with a backup; `--dry-run`
  previews. From cli-core.

### Fixed

- **The browser login page of `mail mcp serve --http` says the app asks to reach your mail** and names
  `mail mcp serve --http`. It said "your messages" and `mail mcp --http`. From cli-core 0.551.0.

## 0.12.0 — 02.11.2026

### Added

- **Work or school accounts: what to do when Microsoft asks for admin approval** ([docs/outlook.md](docs/outlook.md)):
  why `AADSTS90094` appears, the admin-consent link for WireCat's app with how to revoke it, and how an organisation
  registers its own app.

## 0.11.0 — 02.11.2026

### Added

- **A guide to connect Outlook.com or Microsoft 365** ([docs/outlook.md](docs/outlook.md)): turn IMAP on, sign in
  through the browser, sync and send, and what to do when the token is refused or an admin must allow the app.

## 0.10.0 — 02.11.2026

### Changed — may break callers

- **`search messages` says `search.server-partial`, not `search.server-too-large`.** It downloads the first 256 KiB of
  each message the server finds and stores a bigger one with its text and without its attachments; the next `sync`
  reads it whole. Before, a candidate over 5 MB was left on the server and a smaller one was downloaded with all its
  attachments. A script that matched `search.server-too-large` matches `search.server-partial` instead.
- **After `messages send`, `stored` is true only when this message is in the store**, not when any other mail of the
  last 10 minutes was. A caller that read `stored: true` as "some mail was synced" reads it now as "this message is
  stored".
- **`mail.search-refused` is cli-core's reason now** (cli-core 0.550.0); the reason, its code and its message are
  the same.

### Added

- **`--compact` answers one line per item** (cli-base 0.74.0). mail now needs `@wirecat/cli-core` 0.550.0 and
  `@wirecat/cli-base` 0.74.0.
- **`sync` says what became of the emails a search stored text-first**: `partial_emails` with `completed` (read whole
  this run), `left` (waiting for a later run) and `stuck` (given up on: the server no longer gives them where they
  were stored). It is absent when there are none.

### Fixed

- **A Microsoft sign-in whose new token the mail server refuses says how to turn IMAP on.** On Outlook.com IMAP is
  off by default; the error now names the switch (Settings, "Mail", "Forwarding and IMAP", "Let devices and apps use
  IMAP") and no longer claims a refresh was tried. The answer carries the server's response code as `cause_code`, never
  its text.
- **A server that refuses SEARCH no longer looks like an empty folder.** `sync` leaves that folder unread and reads
  the rest: the answer is partial, names it in `refused_folders` with a `mail.search-refused` issue, and nothing of it
  is marked deleted. `messages move`, `copy`, `delete`, `restore` and `drafts` stop with `mail.search-refused`
  instead of acting on nothing (cli-core).
- **On Gmail, an email a search stored text-first is read whole by the next `sync`.** It was never completed there:
  mail worked out its id from the Message-ID, and Gmail's mail is stored under its X-GM-MSGID, so every sync downloaded
  the whole message again and threw it away. `fetchRaw` now reads Gmail's ids beside the bytes.
- **An email a search stored text-first is no longer downloaded whole on every sync when the server no longer gives
  it.** It is read under the UIDVALIDITY it was stored with, and given up on after three failed tries, or at once when
  its place holds another message; it no longer holds back newer ones (cli-core).
- **A search no longer stores a text-first copy over an email a sync in another process stored whole meanwhile**,
  which dropped its attachments (cli-core).
- **The reader of your own Google `--client-file` and the browser opener come from `@wirecat/cli-core` 0.546.0**, not
  copies in mail. The file shapes, the `chmod 600` check and the errors are unchanged.

## 0.9.0 — 02.11.2026

### Added

- **Microsoft sign-in works without a config**: WireCat's Microsoft app is built in. The sign-in sends
  `http://localhost:<port>/callback`, the address registered for it (docs/oauth-microsoft.md). Google keeps
  `127.0.0.1`.

## 0.8.0 — 02.11.2026

### Added

- **Every answer's `meta` says `now` and `now_local`**, the moment it was made (cli-core 0.541.0, cli-base 0.72.0).

### Fixed

- **`search messages` waits 20 seconds for a Yandex server by default**, not 5: one IMAP SEARCH of a large Yandex
  INBOX takes 5 to 7 seconds, so the old default always ran out. `--server-time` still sets it; the provider registry
  holds the value.
- **A scheduled sync no longer fails at 30 seconds while it goes on running.** `schedule exec` waited for the sync with
  the 30 s deadline of a one-shot command, answered `timeout` (exit 9) and left the sync writing for up to 15 minutes.
  It now waits as long as the sync's own deadline allows, and a stop of the run stops the sync too (cli-core).
- **A Gmail sync uses about 200 MB, not 1 to 1.7 GB.** Each round asked the store about every stored email of the
  account; on a 260,000-email mailbox a 30-day sync now takes seconds instead of minutes (cli-core).
- **`search messages --backend` stays inside its time bound**: reading the finds and their attachments counts toward
  `--server-time`, the bound ends before the command's deadline, nothing is written after the command is stopped,
  and a find over 5 MB is left on the server (`search.server-too-large`) (cli-core).

## 0.7.0 — 01.11.2026

### Changed — may break callers

- **`drafts delete` takes `--allow-dangerous`, not `--yes`**, because a draft deleted this way does not come back
  (WC-PERM-9). Only the owner passes it; an agent over MCP gets a preview.

### Added

- **`messages export --output` refuses credential folders** and the WireCat apps' folders, as `attachments download`
  does.
- **Outlook.com and Microsoft 365 sign in with OAuth.** `mail <profile> session start --address <you>@outlook.com`
  shows what it will ask for, opens Microsoft's page in the browser, logs in to IMAP with the new token, and only then
  saves the profile and the tokens (keyring entry `oauth:microsoft:<profile>`). Sync and `messages send` use the token
  over IMAP and SMTP (XOAUTH2), refreshing it as needed; a token the server refuses is refreshed once, then the error
  `mail.oauth-refused` asks for a new sign-in. `session status` shows the app, scopes and expiry, never a token;
  `session end` forgets the sign-in and names where Microsoft lists the app. `--no-browser` prints the link only.
- **`microsoft_client_id`**: the Microsoft app to sign in with, set by you once (`config set --defaults`); an agent
  over MCP cannot change it. WireCat's own app is not registered yet, so for now this is required;
  [register a Microsoft app](docs/oauth-microsoft.md) gives the steps.
- **Gmail over OAuth with your own Google app**: `session start --client-file <Desktop client JSON>`
  (or, on a profile switched with `config set auth oauth`, `MAIL_GOOGLE_CLIENT_ID` and `MAIL_GOOGLE_CLIENT_SECRET`),
  for an account that cannot make an app password. The signed-in address must match the profile's. Gmail profiles
  keep app passwords unless switched.
  [Gmail with your own Google app](docs/oauth-google.md) gives the steps: a Google project just for mail, published
  without verification. `session end --revoke` asks Google to revoke it, which ends every sign-in of that project.
- **`mail doctor` lists each OAuth profile** with its app and last sign-in, from disk only, and warns from day 6 that
  a Google app left in Testing ends its sign-ins on day 7.
- `session status` and `session list` answer `auth` too.

### Fixed

- **An agent over MCP can attach several files**: `--file` of `messages send` and `messages forward` is a list there.
- **Sending a message no longer shortens the archive's coverage** to the last 10 minutes, which memo reported until
  the next full sync.
- **`attachments list` and `download` show every attachment**, not the first 50, and `drafts update` keeps them all.
- **Attachments are saved through cli-core's atomic write**, which also syncs the file and the folder to disk.
- The `memo mail delete` command is named as it is now, in the docs and the help of `messages delete --rules`.
- **Microsoft 365 is its own provider**, found by its MX record, and sends through `smtp.office365.com:587`
  ([Microsoft](https://learn.microsoft.com/en-us/exchange/mail-flow-best-practices/how-to-set-up-a-multifunction-device-or-application-to-send-email-using-microsoft-365-or-office-365));
  Outlook.com keeps `smtp-mail.outlook.com`.

## 0.6.0 — 01.11.2026

### Added

- **`mail <profile> messages export [query] --output <folder>`** writes the original messages of the stored mail that
  match a query to mbox files (one per folder, mboxrd) or a Maildir++ tree (`--format maildir`), for backup or for mu
  and notmuch. The store keeps text only, so each message is read from the server again. The folder is private (mode
  700, files 600); a folder with something in it is refused unless `--resume` goes on with an export or `--replace`
  writes over files of the same name. `--limit` and `--max-pages` bound a run, which also stops before its deadline;
  `--resume` skips what the folder holds and cuts back a half-written message.
- **`mail <profile> stats messages top --by sender|list|domain`** ranks the stored mail by sender, mailing list or
  sender domain, with unread counts and size.
- **`mail <profile> messages mark-read|mark-unread|star|unstar <ref…>`** and **`messages update <ref…> --flag <flag>
  --unflag <flag> [--replace]`** change flags and keywords on the server (read, flagged, answered, draft, `$Junk`, words
  of your own); a folder that keeps no keywords answers `provider_unavailable`.
- **`messages move|copy <ref…> --folder <folder|role>`** files mail by folder; on Gmail a move is a label added and
  `Inbox` taken away, a copy a label added, `--folder archive` only `Inbox` taken away.
- **`messages delete <ref…>`** moves mail to Trash, never expunges it; `--rules` is memo's envelope cleanup, moved
  here: envelope mail the rules let go, each decided again, with Gmail's labels and stars read again just before the
  move, a fresh store backup required and a first run of at most 100; it refuses to run from a schedule.
- **`messages restore --run <id>`** undoes a change run, last step first: Trash back to where the mail was (on Gmail
  with its labels), moves back, copies removed, flags as they were. memo's `mail delete` run ids restore here too.
  Outside Gmail a copy is removed for good by the UID the server gave it, never by a Message-ID search that could find
  the original.
- **`folders create|rename|delete`**; `delete` is a preview until `--yes`, and refuses a folder that holds mail, or
  whose count the server does not give, unless `--allow-dangerous`, which only the owner passes at a terminal.
- **`rules list|add|remove|apply|export|import`**, moved from memo with the same options: the profile is the mailbox,
  so there is no account argument; the default import format is `mail`, the file memo's export writes.
- Every message write takes the messages by `ref` or by `--filter '<query>'` (`--limit`, newest first). A deletion,
  a `--filter` change and a change of more than 20 messages answer with a preview and the command with `--yes` in
  `next`; `--dry-run` only previews. The store follows each server change at once: flags, folder and UID, Gmail labels,
  deletion.
- **Permissions:** `messages.delete`, `folders.delete` and `messages.bulk` (any change of many) ask; the rest of the
  changes go ahead. `MAIL_READ_ONLY=1` refuses them all. Each attempt goes into the send journal (cli-core 0.522.0).
- Error reasons (`mail.no-trash`, `mail.run-unknown`, `mail.archive-unverified`, …) now reach the JSON error.
- **`mail <profile> drafts list|create|update|delete`** keeps drafts in the mailbox's own Drafts folder, so an agent
  writes one and the owner checks and sends it from any mail app. `create` takes `--to`, `--cc`, `--bcc`, `--subject`
  and the text (`-` reads stdin); `--reply-to <ref> [--reply-all]` answers a stored message in its thread. A draft is
  named by its Message-ID; `update` replaces only what is given and keeps the rest, the thread and the attachments,
  and moves the old version to Trash; `delete` removes it for good and asks first (`drafts.delete`).
- **`mail <profile> tags add|remove <tag…> --message <ref> | --chat <ref>`** and **`tags list`** put your own tags on
  stored mail and conversations. They stay in the local store, in the same tables memo tags with, and never reach the
  server; `search messages tag:<tag>` finds them. Provider keywords stay `messages update --flag`, Gmail labels
  `messages move|copy --folder`.
- **`mail doctor`** says when a change run stopped part way, and when mail a run moved to Gmail's Trash is within five
  days of Gmail emptying it, with the `messages restore` command for each. memo's doctor said this until the cleanup
  moved here; memo's own cleanup runs count too. It needs cli-core 0.524.0 (`appDoctorCommand`'s `local` check).
- **`search messages` asks the mail server too** for mail sync has not read yet: `--backend archive|server|both`
  (default `both`) and `--server-time` (default 5s), as `tg search messages` has them. Gmail is searched once in All
  Mail with its own syntax (X-GM-RAW); other servers with IMAP `UID SEARCH` in INBOX, Sent and Archive, or the
  profile's `folders`. The server gets the words, `from:`, `to:`, `cc:`, `subject:`, `body:`, `is:` and `date:`; what
  it finds is stored, and the same query then runs on the store, so the answer means the same on both backends and
  each hit says `found_in`. The mailbox is opened read only. `permissions.messages.server-search=deny` turns it off;
  `--offline` and `MAIL_READ_ONLY` keep to the store (cli-core 0.525.0).
- **`mail <profile> messages send --to … --subject … [text]`** sends over the provider's SMTP server with the same
  app password; the text comes from stdin when left out. `--cc`, `--bcc`, `--file <path>` (repeat; a named path, never
  a pattern; credential and WireCat folders refused without `--allow-any-file`, which an agent over MCP never gets). `--reply-to <ref> [--reply-all]`
  answers a stored email: `In-Reply-To`, `References`, `Re:`, the original quoted, `\Answered` set on it.
- **`messages forward <ref> --to … [text]`** sends the original attached whole (`message/rfc822`), `Fwd:` before its
  subject, and sets `$Forwarded` on it.
- **Sent and the store after a send.** Gmail files SMTP mail in Sent itself; elsewhere the copy (with its Bcc line) is
  appended to Sent unless Sent already holds that Message-ID. The message is then read into the store as `sync` reads it,
  so it has the server's id and never a second row.
- **Safety for sends.** Mail to anyone but the owner asks first: new key `messages.send.others`, default `ask`, which
  the owner may set to `allow`. The question shows from, to, cc, bcc, subject, each attachment and the first
  lines. `MAIL_READ_ONLY=1`, `readonly` and `deny` refuse; every attempt goes into the send journal without addresses,
  subject or text; each recipient counts toward `sends_per_hour`; sends are spaced with the shared request pace
  (cli-core 0.523.0). An answer lost after the message left is `outcome_unknown`; `--operation-id` retries it and sends
  nothing when Sent already has it. `--dry-run` builds the message and sends nothing. A text that says "attached" with
  no file warns.
- **`drafts send <id>`** sends a saved draft through the same path as `messages send` (its keys and question, the
  hourly limit, the journal, the Sent copy), then removes it from Drafts.
- **`attachments list <ref>`** and **`attachments download <ref> [number…] --output-dir <dir> [--replace]`**: the
  files of one email, read from the server and numbered as the store numbers them, saved readable only by you under
  their plain names; an existing file is kept unless `--replace`.
- **Profile keys `smtp_host`, `smtp_port`, `smtp_security`** name the submission server for a provider the built-in
  list does not know. The built-in servers were checked against each provider's help page; Yandex's is now
  `smtp.yandex.ru:465`.

### Changed — may break callers

- **An agent over MCP mails only the owner.** `messages send`, `messages forward` and `drafts send` to anyone else
  answer `permission_error` over MCP until the owner sets `permissions.messages.send.others` in the config (`ask` or
  `allow`); an `mcp serve --permission` cannot open it. At a terminal it still asks.
- `mail` is no longer read-only: an MCP client with `--allow-writes` can change the mailbox through the `write` tool,
  within the profile's permissions.
- **On a server with OBJECTID (Fastmail, Cyrus) an email's id is the hash of its Message-ID, as memo makes it**, not
  the server's EMAILID, and its thread comes from References. Ids come from cli-core's `mailIds`, which memo uses too,
  so the two never store one email twice. Gmail keeps its own ids; Yandex and Mail.ru ids do not change.
- **An agent cannot change where the app password goes, nor who it may mail.** Over MCP, `config set` and
  `config unset` refuse `address`, `login`, `imap_host`, `imap_port`, `imap_security`, `smtp_host`, `smtp_port`,
  `smtp_security`, `auth` and `permissions.messages.send.others` even with `mcp.authority`; the owner changes them in a
  terminal (cli-core 0.530.0).

### Fixed

- **Built on cli-core 0.530.0 and cli-base 0.71.0.** The command lint now knows `drafts`, `--cc`, `--bcc` and
  `--reply-all`, and accepts `--to <address>` and `--subject <text>` beside the messengers' `<chat>` and `<ref>`, so
  thirteen lint overrides are gone and the budget is 11. The audit compares mail in cli-base's `mail-shared` group and
  runs without `--complete`. cli-core also stops hiding a locked store when it scores senders.
- **Gmail labels are decoded once.** imapflow already decodes them, and mail decoded `R&D-team` again into `Rteam`.
- **`sync` says when it leaves stored rules out**: `rules_unread` and `rules_unread_why` (such as `condition label`)
  in the answer and a `mail.rules-unreadable` issue, when the rules hold a condition this mail does not know.
- **`sync --rescan` fails on a locked or broken store** instead of reporting the rethreading done.
- **An attachment's file name is cleaned as cli-core's downloads clean it**: direction and zero-width characters
  that disguise an extension go, and on Windows a reserved name (CON, NUL, …) falls back to `attachment-<n>`.

## 0.5.0 — 01.11.2026

### Fixed

- **A scheduled sync runs from its timer.** The timer starts `mail schedule exec <file>` with no profile, and mail refused it
  with "name a profile" before reading the schedule, so no timed run worked in 0.3.0 and 0.4.0. `schedule exec` now needs
  no profile; the schedule's own environment names it (cli-core 0.521.0).

## 0.4.0 — 01.11.2026

### Added

- **`mail <profile> search messages '<query>'`** searches the profile's stored mail offline, with the query language
  of every WireCat CLI and memo's ranking: any form of a word, `from:`, `to:`, `subject:`, `label:`, `is:unread`,
  `has:attachment`, `content:`, `date>7d`, and `list:` for a mailing list by its List-Id or domain. Mail from a
  suspicious sender comes after the rest (`--plain-order` keeps the words' order); `--newest`, `--exact`, `--page`.
- **`mail <profile> messages show <ref>`** gives one email whole, with the first 4,000 characters of each
  attachment's text (`--full`: all of it and the HTML body), and `--before-n`/`--after-n` emails of its thread, in the
  JSON `memo messages show` gives.
- **`mail <profile> conversations list [query]` and `conversations show <thread>`**: the threads, newest first,
  filtered by `subject:`, `emails_count>1` or `last_email_at>7d`, and one thread's emails oldest first.
- Each reads the profile's own mailbox only; a reference of another mailbox is refused. Over MCP they are `read`
  commands.

## 0.3.0 — 01.11.2026

### Added

- **`mail <profile> schedule`** runs a mail command on a timer through systemd, launchd or Task Scheduler, as `tg`
  does: `mail ya schedule command mail-ya --every 5m -- sync`. `doctor` says when a scheduled run keeps failing.

## 0.2.0 — 01.11.2026

### Added

- **The skill on ClawHub names its program and npm package**, so an OpenClaw user is told to install `@wirecat/mail-cli`
  before the skill works, as with the other WireCat skills.
- **mail's MCP server is listed in the official MCP Registry** as `dev.wirecat/mail-cli`.
- **`session start` prints the server it found before it sends the password**: host, port, security and login, so
  a wrong guess of discovery is seen before the password goes to it.
- **A new profile saves how it signs in (`auth`).** A profile saved before keeps working with its `imap_*` settings and
  signs in with an app password, with nothing to migrate.

### Changed — may break callers

- **`sync` reads All Mail on Gmail when the profile names no folders.** Archived Gmail mail leaves INBOX, so a sync of
  INBOX alone took it for deleted. All Mail is found by its role, so a Gmail account in another language works too.
- **Headers are read as memo reads them.** A mailing list's `List-Id` is stored without its angle
  brackets and in lower case, and Reply-To, Gmail's SPF, DKIM and DMARC verdicts and the attachment hint are read at
  list time, so the owner's rules see the same fields in both tools.

### Fixed

- **`sync` applies the account's stored mail rules, as memo does.** A skip or envelope rule decided in memo now holds
  for `mail sync` too, and both tools keep the same saved position, which holds a fingerprint of the rules. A Gmail
  profile syncs in Gmail mode, as memo does.
- **Gmail labels are named as memo names them** (`Inbox`, `Sent`, `Starred`, decoded names), so stored `label:Inbox`
  mailboxes keep matching and nothing is stored as `label:\Inbox`.
- **`sync --rescan` moves replies stored by 0.1 into their thread** on a server without thread ids, such as Yandex.
  The answer says how many in `rethreaded`. Gmail's threads are not touched.
- **A reply is stored in its conversation on servers without thread ids, such as Yandex and Mail.ru.** The thread is
  the first email named in References, else in In-Reply-To. Mail stored before moves with `sync --rescan`
  (above). Gmail keeps its own ids.
- **Every command that asks the server is bound by the run's deadline and Ctrl-C.** `session start` and
  `session status --check` opened the mailbox on their own, without the deadline or the abort the other commands
  had, and a source could reconnect after it was closed.
- **`sync` asks for at most 20 MB of message bodies in one request**, as well as at most 15 messages, so a batch of
  large attachments does not hold a connection for minutes or fill memory.
- **The schemas of `account check` and `session status` name `file` as a password source.** A password kept in the
  private file was answered as `file` while the published schema allowed only `environment`, `keyring` and
  `himalaya`, so a client that checks answers against the schema refused it.
- **A `sync` that `--limit` stopped says so.** It answers `stopped: "limit"` and how many new emails it left in
  `remaining`, and its next step says the run saved the emails `--limit` allows, instead of saying it stopped to
  answer in time.

## 0.1.1 — 01.11.2026

### Fixed

- **The docs take you from `sync` to a first found email, and say how the password is really kept.** Installation,
  usage and the docs index end with `memo search mail`, since `mail` fills the shared store and memo searches it. The
  password is kept in the keyring, falls back to a private file when the keyring fails, and can come from
  `MAIL_PASSWORD`; it is never read from stdin. `rate_limited` names both causes: the server limiting the account, and
  `sync` running out of its own request budget. The docs also say that `memo mail delete` moves Gmail mail to Trash.

## 0.1.0 — 31.10.2026

### Added

- **`mail` reads a mailbox over IMAP into the shared WireCat store, and never changes the mailbox.** `memo` and the
  other WireCat tools then search and read that mail on your computer. `mail` does not send mail.
- **`session start` signs a profile in with an app password.** A new profile takes `--address`, or asks for it at a
  terminal. It finds the server through a built-in table (Yandex, Gmail, iCloud, Mail.ru, Fastmail), the MX record,
  Thunderbird's ISPDB and the domain's autoconfig file; `--provider`, or `--host` with `--port` and `--security`, sets
  it by hand and skips those lookups. It shows the steps to prepare the mailbox, asks for the app password with no echo
  (or reads `MAIL_PASSWORD`), checks it on the server, and only then saves the profile and keeps the password in the
  OS keyring. Without a terminal it never asks and names the missing option or variable. An app password that
  Himalaya already keeps in the keyring is used when `mail` has none. The steps for every provider are on
  [Prepare the mailbox](https://github.com/WireCatLabs/mail-cli/blob/main/docs/providers.md). Outlook and Microsoft 365
  accept only OAuth, so `session start` refuses them for now.
- **`session status`, `session end` and `session list` manage the sign-in.** `session status --check` logs in to prove
  the password still works; `session end` forgets the password and keeps the synced mail; `session list` takes no
  profile and lists the profiles on this computer.
- **`account check` and `folders list`** log in and show what the server supports, and the folders with their role and
  message counts.
- **`sync` reads new mail into the shared store and skips what is already there.** It reads INBOX and Sent unless
  `--folder` or the profile names other folders, newest first, from `--since-time` (default: the last 30 days). A date
  alone starts at local midnight, and the answer gives the time zone and the window in UTC. `--limit` caps the new
  messages of one run and `--rescan` lists the whole window again. It saves text and headers, not attachments.
- **A big mailbox syncs over several runs.** `sync` spends a request budget sized to its deadline (15 minutes at a
  terminal, 45 seconds over MCP; `--timeout` and `--max-pages` change it), saves after each part and answers
  `state: partial` with the command to go on. `mail <profile> status` shows how far it is, also while a sync runs.
  When messages were left unread or deletions were not checked, the answer says so in `meta.issues`.
- **`sync` survives a flaky server.** A dropped connection is reopened after a short wait and the run goes on; a
  message the server cannot answer now is asked for again at the end of the run and left for the next one. On a server
  with no message ids, such as Yandex, each new message is downloaded once and stored mail is not read again.
- **AI agents use `mail` through MCP and a skill.** `mail <profile> mcp serve` offers the profile's commands to an
  agent over stdio, or over HTTP behind your own tunnel with `--http`; the profile's permissions decide what runs, and
  `--permission` only tightens them. `mail skill install` installs the tool's instructions for Claude Code, Codex,
  Gemini CLI and OpenClaw, and for Hermes with `--for hermes`.
- **The app password falls back to a private file when the keyring fails, and is never asked about.** `session start`
  keeps the password in `credentials.json` (mode 600) in the config folder, says so once on stderr, and answers
  `credential_storage`. `--credential-storage file` chooses the file outright, not recommended. `session status` can
  answer `password_from: "file"`.
- **A run with moved folders never removes the owner's app password from the OS keyring.** Such a run reads the owner's
  password but never replaces or removes it, and stores a new one in a temporary entry. `session end` on the owner's
  password removes nothing and answers `kept: "owners-sign-in"`.
- **`wcat mail` runs the tool, and `wcat --help` lists it.** The package installs `wcat-mail` beside `mail`, and
  `wcat-mail --wcat-describe` prints the tool's name, version and description for `wcat`.
- **`doctor --online` says whether a newer version is published.** It makes no call to the mail server.
- **The commands every WireCat tool shares:** `doctor`, `commands`, `config`, `skill`, `runs` and `upgrade`.
