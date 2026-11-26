### Added

- **Gmail's "send as" addresses count as yours.** A Gmail profile signed in with Google reads its "send as" list at
  each `sync` (`users.settings.sendAs.list`, under the `https://mail.google.com/` scope the sign-in already asks for)
  and counts every address Gmail accepted as yours, beside `aliases`. When Gmail does not answer, the list read last
  is used, and `sync` says why under `send_as.unread`. A profile with an app password reads no list: set `aliases`
  there ([configuration](../docs/configuration.md)).
