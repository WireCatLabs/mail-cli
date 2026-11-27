### Changed — may break callers

- **mail builds on cli-core 2.0.0.** The store moves to version 78 on its first open, and only tools on cli-core 2.0
  open the store after that: a 1.x tool refuses it with `configuration_error`. Upgrade every installed WireCat CLI and
  WireCat Desktop the same day, and stop `serve`, `mcp` and syncs before the first run. The migration writes a rollback
  copy first and refuses to run without one.
- **An agent is `agent`, a sender bot is `bot:<id>`.** In the JSON output the `type` of an author or decider and of
  every actor pair says `"agent"` where it said `"bot"`. A sender bot's ref says `bot:<id>` where it said
  `sender-bot:<id>`. A `sender-bot:<id>` you pass in is still read as `bot:<id>`.
