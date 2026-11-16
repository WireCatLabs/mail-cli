### Changed — may break callers

- **Built on cli-core 0.674.0** (was 0.663.0) and cli-base 0.103.0 (was 0.100.0). The shared store moves to version
  67, so upgrade the other WireCat CLIs that share it too. A command run without a profile it needs now carries the
  reason `profile.missing`. See the
  [cli-core changelog](https://github.com/WireCatLabs/cli-core/blob/main/CHANGELOG.md).

### Fixed

- **WireCat Desktop's texts for mail say what it does.** The sign-in card said mail reads, organises and sends your
  mail. It now says the agent sorts and sends mail as far as your settings allow (deleting and mail to others ask by
  default), and that a Microsoft sign-in may not grant sending. The sync's label is
  "mail", one word, as Desktop expects.
