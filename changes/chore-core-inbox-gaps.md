### Added

- **`inbox` names each thread's sender and reports its run.** Each sorted thread in `inbox --json` carries
  `sender: { name, address }`, the newest email's sender who is not you. `meta.model_run` says what the run did:
  threads sent, sorted and left for the next run, the tokens counted, the cost when the model's price is known, and
  the model and its address. When `inbox` must ask before mail goes to a model outside this computer, the refusal's
  details carry the emails, threads, tokens, host, model and estimated cost, so WireCat Desktop can ask in your
  language (cli-core 0.713.0, cli-base 0.125.0).

### Fixed

- **`inbox` writes its one-line reason in your language.** It used each thread's language; it now uses the first of
  `owner_languages` (`mail config set owner_languages ru,en`).
