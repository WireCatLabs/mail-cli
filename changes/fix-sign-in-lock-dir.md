### Fixed

- **Two first sign-ins at the same moment both keep their record.** The second could fail with `ENOENT` on
  `sign-ins.json.lock`, because the state folder was made only after the lock was taken.
