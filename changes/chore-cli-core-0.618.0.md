### Fixed

- **cli-core 0.618.0 (was 0.614.0).** After `store recover run` (from memo, tg, max or wa) the recovered store makes
  each mail folder forget the UIDs it listed past its last stored email from a day before the last deep check that
  passed, so the next ordinary `mail sync` reads that mail again; `--rescan` is no longer needed for it.
