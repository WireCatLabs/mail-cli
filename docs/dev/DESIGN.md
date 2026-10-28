# mail — design

Written by `npx @wirecat/cli-template new`. The agent reads it first, asks the further questions the reference CLI
does not answer, and starts building only after the owner has read it.

## First task

Delete this section once every step is done (WC-DOC-3).

1. If an answer below is missing, ask the owner the [design interview](skills/design-interview/SKILL.md).
2. Learn from the reference CLI below: its provider, its store and its commands.
3. Ask the further questions in the interview that the reference CLI does not answer, and write the answers here.
   Build only after the owner has read this page.
4. When the first command reaches the service, rewrite `README.md`, `docs/index.md` and the description in
   `skills/mail-cli/SKILL.md` to say what the tool does and who it is for. Rewrite the MCP server's
   instructions in `src/mcp.ts` too: name the kinds of outside text the CLI carries (WC-MCP-11).

## Answers

- **Category:** mail
- **Content languages:** ru, en
- **Sign-in:** other: app-password-and-oauth
- **The API:** official API documentation only
- **How people filter:** by time, by person, by container (chat, folder, calendar), by words in the text, by status or label
- **Never in the store, a log or the output:** tokens and passwords, other: passwords, other: attachment-bytes
- **Untrusted input:** messages from other people, files and attachments, links, names and titles set by others

## Reference CLI

No reference CLI for this category yet: pick the nearest one with the owner from the Reference CLIs page.

## Content languages

Languages: ru, en.

## Further answers

## Open questions for the owner
