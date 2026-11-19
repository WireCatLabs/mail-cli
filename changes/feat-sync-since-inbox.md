### Added

- **`sync_since`: how far back `sync` reads, as a setting.** Before, `sync` read the last 30 days unless a run gave
  `--since-time`, and WireCat Desktop had no way to read further back. The profile setting takes a window back from now
  (`90d`, `12w`, `1y`) or a date (`2025-01-01`). The default stays `30d`. `--since-time` still wins for one run. Make
  the window wider and the next `sync` reads the older mail too, with no `--rescan`. `config show` lists it, and
  `config set sync_since 2x` is refused with the forms it takes. See [Settings](../docs/configuration.md).
- **`inbox` sorts new mail with the AI model you chose**, with no agent: each thread that changed since the last run
  goes under needs an answer, to read or can wait, with a one-line reason. A local Ollama works. It follows local
  only and `memo models chats`, sends at most 40 emails a run, and runs on a schedule. `review` shows the verdict
  as `email.inbox`. See [usage](../docs/usage.md#inbox-new-mail-sorted-by-an-ai-model).
