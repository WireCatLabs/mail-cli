### Fixed

- **`rules apply` and `messages delete --rules` know a sender the owner wrote to before the window.** They judged
  "you wrote to this sender" only from the mail of this run's window, so a sender answered months ago could get an
  envelope rule or be offered for Trash. They now read the owner's stored outgoing mail (cli-core's
  `store.mail.writtenTo`), from every account and with the sender in To or Cc. The cleanup's "replied" reason
  reads the same mail, so it no longer misses a sender answered from another account.

### Changed — may break callers

- **Built on cli-core 0.663.0** (was 0.662.0) and cli-base 0.100.0 (was 0.99.0). See the
  [cli-core changelog](https://github.com/WireCatLabs/cli-core/blob/main/CHANGELOG.md).
