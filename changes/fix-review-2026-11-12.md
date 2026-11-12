### Security

- **mail reaches only the hosts it declares.** Sign-in, the Google account check, server discovery and the sender
  score's registry lookups go through `hostFetch`, which refuses any other host before a byte leaves and checks every
  redirect. A discovery file or a registry that redirects to another host is no longer followed: discovery tries the
  next source, and the registry lookup counts as failed and is asked again on a later run. The package ships
  `contracts/wirecat.json`, so WireCat Desktop shows these hosts before you install mail.

### Fixed

- **Two sign-ins that finish at the same time keep both records.** `sign-ins.json`, which `doctor` reads, is changed
  under a lock, so one profile's record no longer overwrites another's.
