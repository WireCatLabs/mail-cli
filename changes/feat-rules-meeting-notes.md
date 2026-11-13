### Added

- **`rules add --meeting-notes <provider>` saves meeting notes as meetings.** Each email the rule matches is kept whole,
  protected, and on sync also saved as a meeting of that provider, linked to the calendar event in the same room that
  day. Without a condition it matches the provider's sender: `--meeting-notes telemost` is
  `keeper@telemost.yandex.ru`. `rules apply --yes` saves the notes stored before the rule; its dry run counts them.
  `rules list`, `export` and `import` carry the flag.
