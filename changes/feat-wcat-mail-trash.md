### Fixed

- **memo's old cleanup runs are read from wcat's folder.** memo is now `wcat`, and its state folder moves from
  `cli-memo` to `wcat`. mail-cli reads `mail-trash` there. When only the old `cli-memo/mail-trash` exists, mail-cli
  moves it first. When both exist, nothing is merged: it warns once and reads the new one.
