# mail — design

Written by `npx @wirecat/cli-template new`. The agent reads it first, asks the further questions the reference CLI
does not answer, and starts building only after the owner has read it.

## Answers

- **Category:** mail
- **Content languages:** ru, en
- **Sign-in:** other: app-password-and-oauth
- **The API:** official API documentation only
- **How people filter:** by time, by person, by container (chat, folder, calendar), by words in the text, by status or label
- **Never in the store, a log or the output:** tokens and passwords, other: passwords, other: attachment-bytes
- **Untrusted input:** messages from other people, files and attachments, links, names and titles set by others

## Reference CLI

[gcal-cli](https://github.com/WireCatLabs/gcal-cli): a non-messenger source on a cli-core port. Its session, store and command
wiring is the pattern here.

## Content languages

Languages: ru, en.

## Further answers

Claims about our code cite the file. The imapflow notes were read in imapflow 2.9.1's source, not run, except the
`BODY.PEEK` one, which a test asserts. The thread id rule is cli-core's `mailIds`, read, not tested here.

- **Scope of P1:** `session start|status|end` (start also creates the profile), `account check`, `folders list`, `sync`. Messages commands,
  rules, mbox, Gmail extensions, OAuth and sending are later phases.
- **Port:** the `MailSource` shape and `syncMail` come from `@wirecat/cli-core/mail`; mail keeps no copy of either.
- **Port and adapter:** every command opens the mailbox through `openMail` (`src/commands/context.ts:142`), which hands
  it a `MailBackend` (`src/mail/backend.ts:115`): cli-core's `MailSource` plus `folderList`, `check` and `close`. The IMAP
  adapter in `src/mail/imap/` on imapflow is the only implementation: `connection.ts` (connections, deadlines,
  retries), `read.ts` (what the sync reads), `account.ts` (folders and capabilities), `messages.ts` (ids and headers).
  Ids come from cli-core's `mailIds` (`src/mail/imap/messages.ts:48`), which memo uses too, so both give one email one id. On Gmail the ids are its
  X-GM-MSGID and X-GM-THRID, since stored Gmail mail is keyed on them; a Gmail that also announced OBJECTID is refused
  (`src/mail/imap/read.ts:47`), since imapflow would then fetch EMAILID instead. Anywhere else the id is a hash of the Message-ID header, and
  OBJECTID's EMAILID is not used: a server that turns OBJECTID on keeps its ids. Off Gmail a listing asks only for UID,
  flags, date and size (`quick`) and the hash is taken from the Message-ID of the raw message (`identify`), which must
  equal imapflow's ENVELOPE value (the trimmed first header) or stored mail would get a second id. The thread id is a
  hash of the first Message-ID in References, else of In-Reply-To, else of the message's own Message-ID: a reply then
  shares its first email's thread on Yandex and Mail.ru too. Gmail labels arrive decoded from imapflow and are not
  decoded again (`decodedLabelName`, `src/mail/imap/messages.ts:27`).
- **Password:** OS keyring (service `mail-cli`, account the profile; `src/secret.ts:40`); when it fails, a 0600 `credentials.json` in the
  config folder without asking (WC-SECR-4, owner 2026-10-31, which replaces "no file fallback");
  `--credential-storage file` chooses the file. `MAIL_PASSWORD` first; read-only fallback to Himalaya's `secret-tool`
  entry.
- **imapflow, checked against 2.9.1:** a header or body fetch uses `BODY.PEEK` (read in `fetch.js`;
  `src/mail/imap/imap.test.ts:77` asserts the commands sent to a fake server). It opens a folder with `getMailboxLock` and reports `uidValidity` as a bigint.
  A Gmail style `NO [THROTTLED]` surfaces as a plain error with `responseStatus` NO and the code only in the parsed
  response; only the Microsoft 365 backoff text becomes `code ETHROTTLE`, which `fetch` retries three times. imapflow
  keeps one command in flight, so several `UID SEARCH` cannot share a round trip.
- **MCP and doctor:** `mcp` and `doctor` are cli-core's `appMcpCommand` and `appDoctorCommand`, as in gcal; permission
  keys are command paths (`commandPermissions`), so `--permission sync=deny`.
- **Everything mail-specific lives here, not in memo** (owner, 2026-11-04; cli-core `docs/dev/TOOL-BOUNDARIES.md`):
  `account inspect` (memo's `mail inspect`), `messages import` for Google Takeout mbox files (memo's `mode: "mbox"`
  accounts) and the sender scoring with domain ages that `memo sync` ran after each import. The inspect is
  `account inspect` because the vocabulary's `inspect` is "a mailbox without importing" and the account is the
  mailbox; it reads the server, so it is not under `stats`, which counts stored mail. The import is under `messages`
  beside `messages export`, whose mbox it mirrors. The domain-age cache is mail's own (`domain-ages.json` in its state
  folder); memo's old cache is not read, so a domain is asked once more. The probe, the score and `scoreSenders` stay
  in cli-core.
- **A send whose store then fails to close is `outcome_unknown` with its `operation_id`** (owner, 2026-11-05,
  NEED-2219 A). Since the close comes before the answer (WC-LIFE-4), the message has left by then; the error says it
  was probably sent, and `--operation-id` looks in Sent before it sends (`closedAfterSending`,
  `src/commands/messages.ts`). When the command itself failed, its own error is kept and a failed close is dropped.
- **A change answers its run as `run_id`; `messages restore` answers `run_id` and `restored_run_id`** (owner,
  2026-11-05, NEED-2207, renamed with no old keys kept). `run_id` is the registered name (WC-OUT-12), and in every
  answer it is the run this command made, as `meta.run_id` is; the run a restore undid is `restored_run_id`. The
  option stays `--run <id>`, cli-base's vocabulary flag "the run it is about" (WC-CMD-10), so a next step's
  `args: { run }`, which names options, stays too.
- **A run's cap is `--max-messages`; the export's folder is `--output-dir`** (owner, 2026-11-05, NEED-2208 A, renamed
  with no old flags kept). cli-base's vocabulary keeps `--limit` for "how many items" an answer shows and gives a
  budget its own flag, so `sync`, `messages import` and `messages export` take `--max-messages` ("at most this many
  messages in one run"). `--output` is "the file to write" and `--output-dir` "the folder to write into" (WC-CMD-10).
  The `messages` changes keep `--limit` with `--filter`: it bounds which items the query selects, as a search's does.
- **A person reads times in their own zone; storage and JSON stay UTC** (owner, 2026-11-05, NEED-2215 A). mail's own
  answers go through `answerLocally` (`src/commands/times.ts`): in pretty output every UTC time of the item becomes
  wall time in the zone in use, without an offset, and one line names the zone (WC-TIME-4). JSON, JSONL, compact
  rows and agents keep UTC (WC-TIME-2); `next` is never rewritten, since its args run. The answers cli-core draws
  (`search messages`, `conversations`, `messages show`, `review`, `runs list`) still print UTC: that is fixed in
  cli-core.
- **Exceptions to the WireCat standard.** Neither rule has a lint check, so `lint/overrides.json` cannot hold them;
  they are kept here.
  - **WC-OUT-4: `rules export` prints the bare rules file, with no `{ item, meta }` envelope** (owner, 2026-11-05,
    NEED-2205 A). The rules file is an exchange format: `rules import` and memo read it as written, and an envelope
    would make every saved export a file neither of them takes.
  - **WC-CMD-7: `account inspect` stays under `account`, not under `stats`** (owner, 2026-11-05, NEED-2210 B). It
    checks an account, reading the server without importing, as the bullet on "Everything mail-specific" above says;
    it is not a statistic over stored mail, which is what `stats messages` counts.
- **Each write has its own `operation_id`, not only the run** (owner, 2026-11-05, NEED-2206 B; WC-OUT-10). `Changer`
  (`src/mail/organise.ts`) gives every step one, writes it into the step's line of the change log before the server
  is asked, and lists the step under `writes` in the answer; a restore's step adds `undoes`, the id of the step it
  reverses. Folder and draft writes answer theirs; so does the draft removal after `drafts send` (`op: "delete"`), and
  a Gmail restore from Trash lists the relabel on All Mail as a `label` write that undoes the same step.
- **`messages restore --write <id>` undoes one write of a run** (owner, 2026-11-06, NEED-2226 A). `--write` is the
  vocabulary's flag for one write by its `operation_id` (cli-base 0.80.0), apart from `--operation-id`, the retry of
  an unknown outcome (WC-CMD-10). A run logged before writes had ids, or an id the run does not hold, is refused
  (`mail.write-unknown`). What comes back is recorded per write (`undoes` on the change log's `restore` line), so a
  later restore of the whole run still undoes the run's other writes of the same message.
- **Only `sync`, `messages import` and `messages export` finish their current step on a stop** (owner, 2026-11-05,
  NEED-2214 A for sync and import; 2026-11-06, NEED-2225 A for export). All three are `cooperative` (WC-LIFE-10).
  Sync and import hand the signal to cli-core's `syncMail`, which checks it before each read and right after it,
  saving what was stored before it throws: the read in flight completes, its mail is stored by the next run, and
  nothing after it starts. Export checks it before each batch: the batch in flight is read and written, the answer
  says `stopped: "cancelled"`, and `--resume` goes on (`src/stop.test.ts`). Every other long command stops at once.

## Open questions for the owner

None at the moment.
