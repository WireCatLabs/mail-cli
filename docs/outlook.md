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
   [work or school account](#work-or-school-account-microsoft-365) for what an admin may need to allow.

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

## Work or school account (Microsoft 365)

Use the same command with your work address. Personal Outlook.com and Hotmail accounts are not affected by this
section.

### What you see, and why

WireCat's Microsoft app is not yet publisher-verified. A work or school account belongs to an organisation (a
"tenant"), and Microsoft does not let ordinary users of another tenant approve a multi-tenant app that has no verified
publisher. Instead the sign-in stops with a page that says "Need admin approval", or with the error `AADSTS90094` (the
administrator must grant consent). The browser shows this page, so `mail` itself prints no Microsoft error code. The
page is not a fault in your account or in `mail`. An admin has to act once, then everyone in the organisation signs in
as usual. Microsoft describes the rule on
[Configure risk-based step-up consent](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-risk-based-step-up-consent).

Pick one of the two options below and send it to your admin.

### Option A: the admin allows WireCat's app for the organisation

The admin opens this link in a browser and signs in with an admin account. Replace `{tenant}` with the organisation's
domain (for example `contoso.com`) or its tenant id:

```text
https://login.microsoftonline.com/{tenant}/v2.0/adminconsent?client_id=f7f05d3a-b948-4d50-b3ce-59c816ce69e9&scope=offline_access%20https://outlook.office.com/IMAP.AccessAsUser.All%20https://outlook.office.com/SMTP.Send&redirect_uri=http://localhost/callback
```

The format comes from Microsoft's
[admin consent protocol](https://learn.microsoft.com/en-us/entra/identity-platform/v2-admin-consent): the `/v2.0/adminconsent`
endpoint with `client_id`, `scope` (space-separated, written `%20` in a link) and a `redirect_uri` that is registered
for the app. The account needs a role that may grant consent for the organisation, such as Cloud Application
Administrator or Privileged Role Administrator ([roles](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/grant-admin-consent#prerequisites)).

The admin sees Microsoft's consent page for WireCat. It lists the three permissions and marks the publisher as
unverified. The admin selects "Accept". Microsoft then sends the browser to `http://localhost/callback`; the tab may
show a connection error because nothing listens there, and that is expected. The consent is already saved.

To undo it, the admin opens the [Microsoft Entra admin center](https://entra.microsoft.com), then "Entra ID", "Enterprise
apps", "All applications", WireCat, "Permissions", the "Admin consent" tab, and selects "Revoke permission" on each
entry. To remove the app from the organisation, the admin deletes WireCat from "Enterprise apps" instead
([steps](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/manage-application-permissions)).

### Option B: the organisation registers its own app

If your organisation does not allow third-party apps, an admin registers a private app, which needs no publisher
verification inside its own tenant:

1. In the Microsoft Entra admin center, register an application. Platform: "Mobile and desktop applications".
   Redirect URI: `http://localhost/callback`. Turn "Allow public client flows" to Yes.
2. Copy the Application (client) ID.
3. Each user sets it once, in a terminal:

   ```sh
   mail config set --defaults microsoft_client_id <application-client-id>
   ```

The full steps, with the permissions to list, are in [Microsoft app registration](oauth-microsoft.md).

### Sending can still fail

The organisation may also have "Authenticated SMTP" off for your mailbox. Security defaults, and organisations created
after January 2020, have it off until an admin turns it on. Reading works either way; only sending fails.

## If it does not work

| You see | Do this |
|---|---|
| "refused the OAuth token from this sign-in" | IMAP is off. Turn it on as in [Before you start](#before-you-start), then run `session start` again. On Microsoft 365, ask an admin whether IMAP is on for the mailbox. |
| `AADSTS90094` or "Need admin approval" | See [work or school account](#work-or-school-account-microsoft-365). |
| "Microsoft refused the OAuth login for sending", and reading works | "Authenticated SMTP" is off for the mailbox. An admin turns it on. |
| The browser does not open | Run the command again with `--no-browser` and open the printed link. |

More errors: [troubleshooting](troubleshooting.md).

## Advanced: your own Microsoft app

Use this only if your organisation requires its own app. Register it ([steps](oauth-microsoft.md)): platform "Mobile and
desktop applications", redirect `http://localhost/callback` with no port, never "Web". Then set its id once, in a
terminal, with your app's id in place of the example id:

```sh
mail config set --defaults microsoft_client_id 11111111-2222-3333-4444-555555555555
```

Only you can set it; an agent over MCP is refused.
