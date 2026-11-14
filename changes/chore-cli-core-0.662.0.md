### Changed — may break callers

- **A `readonly` level no longer stops `mail sync`** (cli-core 0.662.0, was 0.661.0). A command that only fetches
  mail into the local store runs at `readonly`; `deny` still refuses it. Commands
  that write the owner's files or call another service stay blocked by `readonly`. A profile that used `readonly`
  to stop syncing sets the key to `deny`.
