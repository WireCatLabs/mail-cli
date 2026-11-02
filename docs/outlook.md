# Connect Outlook.com or Microsoft 365

Use this page to connect an Outlook.com, Hotmail or Microsoft 365 mailbox to `mail`. You sign in to Microsoft in your
browser and approve access. You type no password into `mail`, and WireCat's Microsoft app is built in, so you register
nothing. When you finish, `mail` reads your mail into the local store and can send from the address.

## Before you start

1. Install `mail` ([installation](installation.md)).
2. Outlook.com only: turn IMAP on. Microsoft has it off by default
   ([Microsoft's page](https://support.microsoft.com/en-us/office/pop-imap-and-smtp-settings-for-outlook-com-d088b986-291d-42b8-9564-9c414e2aa040)).
   With IMAP off, the browser sign-in works but the mail server refuses the token, so skip this step at your cost:
   1. Open [outlook.live.com](https://outlook.live.com) and sign in.
   2. Select Settings (the cog), then "Mail", then "Forwarding and IMAP".
   3. Turn on "Let devices and apps use IMAP" and select "Save".
3. Microsoft 365 work or school account: there is nothing to turn on in the mailbox. See
   [work and school accounts](#work-and-school-accounts) for what an admin may need to allow.

## Sign in

Pick a profile name (`outlook` here) and use your own address:

```sh
mail outlook session start --address you@outlook.com
```

`mail` opens your browser on Microsoft's sign-in page. Sign in and approve access. The tab then says "Sign-in
received; you can close this tab". Go back to the terminal: `mail` answers with the profile, `signed_in`, the login
(`auth` is `oauth`, `provider` is `microsoft`, `client` is `wirecat`), the scopes it was given (`IMAP.AccessAsUser.All`
and `SMTP.Send`) and the folders it found.

On a computer with no browser, for example over SSH, add `--no-browser`. `mail` prints the link instead; open it on
any computer, sign in, and the terminal finishes the same way.

## Read and send

```sh
mail outlook sync                                  # INBOX and Sent by default
mail outlook schedule command mail-outlook --every 5m -- sync   # sync every 5 minutes
mail outlook search messages invoice               # search what sync stored
```

Sending uses the same sign-in, over Microsoft's SMTP server with OAuth. `mail` files a copy in Sent. The commands are in
[usage](usage.md) and [all commands](commands.md).

## Work and school accounts

Microsoft 365 accounts use the same command with your work address. Two things belong to your organisation, not to
`mail`:

- **The admin may need to allow the app.** If Microsoft says an admin must approve it, ask your admin to grant consent,
  or to register the organisation's own app and give you its id.
- **Sending needs "Authenticated SMTP" on for your mailbox.** Security defaults, and organisations created after
  January 2020, have it off until an admin turns it on. Reading works either way.

## If it does not work

| You see | Do this |
|---|---|
| "refused the OAuth token from this sign-in" | IMAP is off. Turn it on as in [Before you start](#before-you-start), then run `session start` again. On Microsoft 365, ask an admin whether IMAP is on for the mailbox. |
| Microsoft says an admin must approve the app | See [work and school accounts](#work-and-school-accounts). |
| "Microsoft refused the OAuth login for sending", and reading works | "Authenticated SMTP" is off for the mailbox. An admin turns it on. |
| The browser does not open | Run the command again with `--no-browser` and open the printed link. |

More errors: [troubleshooting](troubleshooting.md).

## Advanced: your own Microsoft app

Use this only if your organisation requires its own app. Register it ([steps](oauth-microsoft.md)): platform "Mobile and
desktop applications", redirect `http://localhost/callback` with no port, never "Web". Then set its id once, in a
terminal:

```sh
mail config set --defaults microsoft_client_id <application-client-id>
```

Only you can set it; an agent over MCP is refused.
