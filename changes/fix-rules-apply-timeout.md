### Added

- **`rules apply --cursor` goes on from where a stopped run ended.** A run that reaches its time limit answers
  `state: partial` with the cursor and the step that goes on. The run that ends the window reports the counts for
  all of it.
- **`rules apply` takes `--yes` over MCP.** An agent could only preview it: the tool did not offer `--yes`.

### Fixed

- **`rules apply` finishes on a large mailbox, and over MCP it answers in time.** It failed after 27 seconds on a
  mailbox of 17,000 emails, which takes about 4 minutes to list. It now runs up to 15 minutes by default (45 seconds
  over MCP, where clients give up after about a minute; `--timeout` still sets it). It reads the headers newest first
  and saves its work batch by batch, so a run that stops keeps what it did.
- **`rules apply` says when it runs out of its time limit.** The error said the mail server did not answer in time.
  Now it says the command reached its time limit and to run it again with a longer `--timeout`.
