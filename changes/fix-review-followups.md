### Fixed

- **`rules apply` and `messages delete --rules` know a sender the owner wrote to before the window.** They judged
  "you wrote to this sender" only from the mail of this run's window, so a sender answered months ago could get an
  envelope rule or be offered for Trash. They now also read the owner's stored outgoing mail (cli-core's
  `store.mail.writtenTo`).

### Changed — may break callers

- **Needs `@wirecat/cli-base` 0.100.0** (was 0.99.0), as the next cli-core does.
