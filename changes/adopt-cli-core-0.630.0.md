### Changed — may break callers

- **Built on cli-core 0.630.0** (was 0.618.0). The store moves to version 63 on first open. A mailbox you connect
  under another person's name is no longer joined to you: it waits for you as a proposal. What changed in between is
  in [cli-core's changelog](https://github.com/WireCatLabs/cli-core/blob/main/CHANGELOG.md).
- **`schedule pause <name>` and `schedule resume <name>`** take a schedule off its timer and keep it; `schedule run`
  still runs it. `--at` repeats: `--at 08:30 --at 18:00` runs twice a day.
