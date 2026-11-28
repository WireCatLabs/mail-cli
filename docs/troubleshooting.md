# When something goes wrong

A sync stopped, a sign-in failed or a command was refused. Most fixes take a minute: find what you see, run the fix,
then run your command again. If it works, the fix held.

`mail doctor` is the first check for every problem. It reads no keyring and uses no network.

**On this page:**

1. [Setup and settings](#setup-and-settings)
2. [Sign-in and password](#sign-in-and-password)
3. [Sync and missing mail](#sync-and-missing-mail)
4. [A change or a send was refused](#a-change-or-a-send-was-refused)
5. [If it still does not work](#if-it-still-does-not-work)

## Setup and settings

| What you see | What to do |
| --- | --- |
| `mail` is not found | Open a new terminal, and check that npm's global folder is on `PATH`. |
| "name a profile" | Put the profile first, as in `mail personal folders list`, or set `MAIL_PROFILE`. |
| The settings file does not read | `doctor` lists every problem in the file under `config.issues`. Run the `config unset` each one gives, or fix the file by hand. |
| `doctor` lists `files.problems` | Other users of the computer can read `config.json` or enter its folder. Run each `chmod` that `doctor` prints after "to make it private:". `doctor` never changes a file mode itself. |

## Sign-in and password

| What you see | What to do |
| --- | --- |
| "no app password for profile" | Run `mail personal session start`, or set `MAIL_PASSWORD` for one run. |
| "the mail server refused the login" | The app password is wrong, or IMAP and app passwords are off. The steps for every provider are in [prepare the mailbox](providers.md). Yandex also needs 2 to 3 hours after a new app password. Then `session start` again. |
| "could not reach the OS keyring" | The keyring is locked or no secret service runs. The password was kept in a private file instead (`credential_storage: "file"`). Unlock the keyring and run `session start` again to move it back. |
| "refused the OAuth token from this sign-in" | The browser sign-in worked, but the mail server refused the new token. On Outlook.com, IMAP is off by default: open Settings (the cog), "Mail", "Forwarding and IMAP", turn on "Let devices and apps use IMAP", click "Save", then `session start` again. On Microsoft 365, IMAP may be off for the mailbox; ask an admin. |
| "refused the OAuth token even after a refresh" | The sign-in was revoked (a password change, sessions signed out, or the app removed). Run `mail personal session start` again. |
| Microsoft says an admin must approve the app, or `AADSTS90094` | Your organisation allows only approved apps. Ask an admin to grant consent ([link and steps](outlook.md#work-or-school-account-microsoft-365)), or to register the organisation's own app ([steps](oauth-microsoft.md)) and give you its id. |
| Gmail over OAuth stops working after a week | The Google app is still in Testing, where Google ends sign-ins after 7 days. Publish it ([steps](oauth-google.md#4-publish-the-app-production-without-verification)), then `session start` again. `mail doctor` warns from day 6. |

## Sync and missing mail

| What you see | What to do |
| --- | --- |
| `sync` answers `state: partial` | A big mailbox does not fit in one run. Run the command in `next` again; mail already stored is skipped. `mail personal status` shows how far it got. |
| The server limits the account (`rate_limited`) | The command fails with "the mail server is limiting this account". Wait, then run it again. When `sync` used its own request budget instead, it does not fail: it answers `state: partial` with `stopped: "requests"`. Run it again, or raise `--max-pages`. |
| Older mail is missing | `sync` reads the last 30 days. Set `mail personal config set sync_since 1y`, then `sync` again. |
| `doctor` lists `changes.unfinished` or `changes.expiring` | A change run stopped part way, or mail a run moved to Gmail's Trash is days from being emptied. Run the `messages restore --run … --yes` that `doctor` prints, with the profile of that mailbox, or run the first command again to finish it. |

## A change or a send was refused

| What you see | What to do |
| --- | --- |
| A write is refused | The profile's permissions or `MAIL_READ_ONLY` stop it; see [settings](configuration.md#permissions). |
| `confirmation_required` (exit 7) | A deletion or a change of many waits for an answer, and no terminal can give one. Run the command again with `--yes`, as `next` shows. |
| An agent's mail to someone else is refused | Over MCP an agent mails only you until you set `permissions.messages.send.others` yourself. |
| "Microsoft refused the OAuth login for sending" | Reading works but sending does not: "Authenticated SMTP" is off for the Microsoft 365 mailbox, often through security defaults. An admin turns it on per mailbox. |

## If it still does not work

Open an [issue on GitHub](https://github.com/WireCatLabs/mail-cli/issues) with the error code, the command you ran
and what `mail doctor` shows. Never paste a token, a password or private content into it.
