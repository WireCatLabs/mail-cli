### Fixed

- **memo's old cleanup runs are read from wcat's folder.** memo is now `wcat`, and its state folder moves from
  `cli-memo` to `wcat`. mail-cli reads `mail-trash` there. When only the old `cli-memo/mail-trash` exists, mail-cli
  moves it first. When both exist, nothing is merged: it warns once and reads the new one.
- mail no longer carries its own copy of cli-core: built on @wirecat/cli-core 3.0.0 and @wirecat/cli-base 2.1.0,
  needed for WireCat store version 79.
