### Changed — may break callers

- **Built on cli-core 0.648.0** (was 0.647.0). A profile name that no profile has now exits with code 6.
  `store reset` is no longer offered over MCP. What changed in between is in
  [cli-core's changelog](https://github.com/WireCatLabs/cli-core/blob/main/CHANGELOG.md).

### Security

- **mail reaches only the hosts it declares.** Sign-in, the Google account check, server discovery and the sender
  score's registry lookups go through `hostFetch`, which refuses any other host before a byte leaves and checks every
  redirect. A discovery file or a registry that redirects to another host is no longer followed: discovery tries the
  next source, and the registry lookup counts as failed and is asked again on a later run. The package ships
  `contracts/wirecat.json`, so WireCat Desktop shows these hosts before you install mail.

### Fixed

- **Two sign-ins that finish at the same time keep both records.** `sign-ins.json`, which `doctor` reads, is changed
  under a lock, so one profile's record no longer overwrites another's.
