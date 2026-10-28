---
name: design-interview
description: Ask the owner the seven design questions for a new WireCat CLI before building anything, then the further questions the reference CLI does not answer, and write the answers to docs/dev/DESIGN.md. Use when DESIGN.md has no answers, when asked to design or start the CLI, «спроектировать», «начать CLI».
---

# Design interview

Ask before you build. Each question is multiple choice, and every one also takes "Other", typed by hand. Ask them in
this order, one at a time, and write each answer down as it comes. `npx @wirecat/cli-template new` asks the same
questions in a terminal and takes them as flags without one; when `DESIGN.md` already has the answers, read them and
go to the further questions.

1. **What kind of tool is it?** messenger · mail · notes · files and documents · calendar · meetings · other. It
   picks the reference CLI (see [Reference CLIs](../../reference-clis.md)).
2. **Which languages is the content in?** Any languages, several allowed: the messages, documents or transcripts the
   CLI handles. The answer picks the language-dependent parts: search stemming, the embedding and speech models.
3. **How does a person sign in?** OAuth in the browser · an API token or key · a session (phone code, QR) · none ·
   other.
4. **What does the service offer to build on?** an official API with an official client library · official API
   documentation only · nothing official · other.
5. **How do people filter what they find?** by time · by person · by container (chat, folder, calendar) · by words in
   the text · by status or label · other; several allowed.
6. **What must never reach the store, a log or the output?** tokens and passwords · one-time codes and passcodes ·
   links that carry a secret · the full content, keep only metadata · other; several allowed. A run record keeps
   the words typed on the command line: an argument or option that carries such a value is marked with
   `secretInput()` from `@wirecat/cli-core/cli`.
7. **What untrusted input arrives?** messages from other people · files and attachments · links · names and titles set
   by others · none · other; several allowed.

Then read the reference CLI and ask the [further questions](../../design-questions.md) it does not answer.

## What to write

`docs/dev/DESIGN.md`: the seven answers, the reference CLI, the further answers, and a list of open questions for
the owner. Name the reference CLI in `AGENTS.md`, between the `cli-template:reference-cli` markers. Start building
only after the owner has read `DESIGN.md`.
