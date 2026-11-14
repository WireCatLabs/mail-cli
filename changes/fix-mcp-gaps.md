### Fixed

- **`rules import --format gmail` takes `--yes` over MCP.** An agent could only preview the rules Gmail's filters
  suggest: the tool offered only the command's own options, and `--yes` was the program's.
- **`rules export` answers over MCP.** The call failed with "the command printed its answer instead of handing it
  over". An agent now gets the rules file as the answer; in a terminal and in a pipe it still prints the file itself,
  so `rules export > rules.json` imports back.
- **`rules apply` no longer offers a run that read nothing to run again under the same time limit.** Over MCP the
  step said to pass a longer `--timeout`, which an agent cannot, and was marked safe to run unasked, so a resumed run
  could repeat with no progress. Over MCP it now tells the owner to give the server a longer `MAIL_TIMEOUT` or to run
  it in a terminal; in a terminal the step adds `--timeout 30m` and waits for the owner.
