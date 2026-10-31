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

- **Scope of P1:** `session start|status|end` (start also creates the profile), `account check`, `folders list`, `sync`. Messages commands,
  rules, mbox, Gmail extensions, OAuth and sending are later phases.
- **Port:** the `MailSource` shape and `syncMail` come from `@wirecat/cli-core/mail`; mail keeps no copy of either.
- **Adapter:** `src/mail/imap.ts` on imapflow. A message id is the server's email id when it gives one (OBJECTID or
  Gmail's X-GM-MSGID), else a hash of the Message-ID header. On a server with neither (Yandex) a listing asks only for
  UID, flags, date and size (`quick`) and the hash is taken from the Message-ID of the raw message (`identify`), which
  must equal imapflow's ENVELOPE value (the trimmed first header) or stored mail would get a second id.
- **Password:** OS keyring only (service `mail-cli`, account the profile); `MAIL_PASSWORD` for a run with no keyring;
  read-only fallback to Himalaya's `secret-tool` entry. No file fallback.
- **imapflow, checked against 2.9.1:** a header or body fetch uses `BODY.PEEK` (read in `fetch.js`; the test asserts
  the commands sent to a fake server). It opens a folder with `getMailboxLock` and reports `uidValidity` as a bigint.
  A Gmail style `NO [THROTTLED]` surfaces as a plain error with `responseStatus` NO and the code only in the parsed
  response; only the Microsoft 365 backoff text becomes `code ETHROTTLE`, which `fetch` retries three times. imapflow
  keeps one command in flight, so several `UID SEARCH` cannot share a round trip.
- **MCP and doctor:** `mcp` and `doctor` are cli-core's `appMcpCommand` and `appDoctorCommand`, as in gcal; permission
  keys are command paths (`commandPermissions`), so `--permission sync=deny`.

## Open questions for the owner
