# When something goes wrong

Start with the symptom, run the check, then retry the command. Keep the error code and the profile name for a
support request.

| Symptom | What to do |
| --- | --- |
| Not sure what is set up | Run `mail doctor`. It reads no keyring and uses no network. |
| `mail` is not found | Open a new terminal, and check that npm's global folder is on `PATH`. |
| "name a profile" | Put the profile first, as in `mail ya folders list`, or set `MAIL_PROFILE`. |
| The settings file does not read | `doctor` lists every problem in the file under `config.issues`. Run the `config unset` each one gives, or fix the file by hand. |
| `doctor` lists `files.problems` | Other users of the computer can read `config.json` or enter its folder. Run each `chmod` that `doctor` prints after "to make it private:". `doctor` never changes a file mode itself. |
| `doctor` lists `changes.unfinished` or `changes.expiring` | A change run stopped part way, or mail a run moved to Gmail's Trash is days from being emptied. Run the `messages restore --run <id> --yes` that `doctor` prints, with the profile of that mailbox, or run the first command again to finish it. |
| "no app password for profile" | Run `mail <profile> session start`, or set `MAIL_PASSWORD` for one run. |
| "the mail server refused the login" | The app password is wrong, or IMAP and app passwords are off. The steps for every provider are in [prepare the mailbox](providers.md). Yandex also needs 2 to 3 hours after a new app password. Then `session start` again. |
| `rate_limited` | Two causes. **The server limits the account:** the command fails with the error "the mail server is limiting this account"; wait, then run it again. **`sync` used its own request budget:** `sync` does not fail. It answers `state: partial` with `stopped: "requests"`, and `meta.issues` has `rate_limited` with the reason `budget.requests`; run `sync` again to go on, or raise `--max-pages`. Mail already stored is skipped in both cases. |
| "could not reach the OS keyring" | The keyring is locked or no secret service runs. The password was kept in a private file instead (`credential_storage: "file"`). Unlock the keyring and run `session start` again to move it back. |
| "no Microsoft app to sign in with" | This build of `mail` has no WireCat Microsoft app yet. Register your own ([steps](oauth-microsoft.md)) and run `mail config set --defaults microsoft_client_id <id>`. |
| "refused the OAuth token even after a refresh" | The sign-in was revoked (a password change, sessions signed out, or the app removed). Run `mail <profile> session start` again. |
| Microsoft says an admin must approve the app | Your organisation allows only approved apps. Ask an admin to grant consent, or to register the organisation's own app ([steps](oauth-microsoft.md)) and give you its id. |
| "Microsoft refused the OAuth login for sending" | Reading works but sending does not: "Authenticated SMTP" is off for the Microsoft 365 mailbox, often through security defaults. An admin turns it on per mailbox. |
| A write is refused | The profile's permissions or `MAIL_READ_ONLY` stop it; see [settings](configuration.md#permissions). |

Never paste a token, a password or private content into a support request.
