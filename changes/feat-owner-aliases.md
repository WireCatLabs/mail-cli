### Added

- **`aliases`: the owner's other addresses on a mailbox.** `mail personal config set aliases
  me@work.example.com,me.alias@example.com` names the addresses you also send from. Mail from one is yours, so the
  people you wrote to from it get a mail tie, and mail to one is addressed to you, so `review --unanswered` and
  `tasks agenda` count it as owed. Only you set it, at a terminal: an agent cannot
  ([configuration](../docs/configuration.md); cli-core 0.753.0).

### Fixed

- **Mail in Sent is yours whatever its From.** `sync` now tells cli-core which folder the server marks `\Sent`, so mail
  you sent from another address and filed in Sent counts as outgoing, and its sender joins your addresses.
