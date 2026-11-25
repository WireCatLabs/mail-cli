### Changed — may break callers

- **mail builds on cli-core 1.0.0 and cli-base 1.0.0.** The store moves to version 73 on its first open: an id is never
  handed out twice, and only tools on cli-core 1.0 open the store after that. Upgrade every installed WireCat CLI
  before you run this version. The migration writes a rollback copy first and refuses to run without one.
- **An MCP call that names a refused place answers `permission_error`**, not `validation_error`. Before any MCP call
  runs, each option and argument that takes a local file or folder is checked by its real path: a call cannot name a
  credential folder, a folder of a WireCat tool or the message store. A shell run is unchanged.
- **`schedule exec` is no longer offered over MCP.** It runs only a schedule file in the tool's own schedules folder.
  An agent runs a saved schedule with `schedule run <name>`.
- **An unreadable config file now answers `config.unreadable`**, not `mail.config-unreadable`: the one name the
  WireCat family uses for it.

### Fixed

- **A sync no longer marks mail deleted that the server's search found and its listing left out.** When a folder's
  listing returns fewer messages than its search, the run skips the deletion check and says why in
  `deletionsSkipped`.
- **A mailbox folder named over MCP stays the server's name.** `--folder` of `sync`, `session start`,
  `account inspect`, `messages move`, `messages copy` and `messages export`, and the folder of `folders create`,
  `folders rename` and `folders delete`, name a folder on the mail server, not on this computer, so `serve` passes
  them on as given.
