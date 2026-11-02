# Register a Microsoft app

Outlook.com and Microsoft 365 take only OAuth for IMAP and SMTP, so `mail` signs in through a Microsoft app. This page
is for whoever registers that app: WireCat once for everyone, or you for yourself. It takes about half an hour, and it
costs nothing.

When the app exists, its **Application (client) ID** goes either into `mail` itself (WireCat's app), or into your
config once:

```sh
mail config set --defaults microsoft_client_id <application-client-id>
```

Only you can set it, in a terminal: an agent over MCP is refused, as for the mail server settings. The id is public; a
desktop app has no secret.

## What you need

- A Microsoft account that can create apps in a Microsoft Entra tenant. A work or school account usually can. A
  personal Outlook.com account has no tenant of its own: sign up for a free Azure account first, which makes one
  ([register an app](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app), prerequisites).
- A personal Outlook.com mailbox, to test the app at the end.

## Steps

1. Open the [Microsoft Entra admin center](https://entra.microsoft.com) and sign in.
2. Open **App registrations** (type it in the search box at the top), and select **New registration**.
3. Fill in the form:
   - **Name**: `WireCat mail` (users see it on the consent page).
   - **Supported account types**: **Any Entra ID Tenant + Personal Microsoft accounts**. Without the personal
     accounts, Outlook.com users cannot sign in.
   - **Redirect URI**: leave it empty here; step 6 adds it.
4. Select **Register**. The app's **Overview** page opens. Copy the **Application (client) ID**: that is the id `mail`
   needs.
5. Allow the desktop sign-in: under **Manage**, select **Authentication**. Under **Advanced settings**, set **Allow
   public client flows** to **Yes**, and select **Save**.
6. Add the redirect URI. Under **Manage**, select **Authentication**, then **Add a platform**, then **Mobile and desktop
   applications**. In **Custom redirect URIs** enter `http://localhost/callback`, with no port, and select **Configure**.
   `mail` signs in through `http://localhost:<port>/callback` with a new port each time; Microsoft ignores the port only
   for `localhost` addresses and requires the path to match
   ([redirect URI rules](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url)). No manifest edit is
   needed. Do not put the address under a **Web** platform: that kind of app expects a client secret, and a public
   client sign-in with it fails. If the address is already listed under **Web**, remove it there.
7. List the permissions, so the consent page and admins see them up front. The sign-in asks for them by name anyway
   ([scopes](https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth)),
   so this step is recommended, not required. Microsoft's page gives no portal steps for these delegated permissions;
   they are usually under **Manage**, **API permissions**, **Add a permission**, **Microsoft Graph**, **Delegated
   permissions** (if not, **APIs my organization uses**, **Office 365 Exchange Online**). Tick:
   - `IMAP.AccessAsUser.All`
   - `SMTP.Send`
   - `offline_access`

   Select **Add permissions**. Do not grant admin consent for these: each person allows them for their own mailbox
   when they sign in. Microsoft lets users do that by default for their own mail
   ([user consent](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-user-consent)).
8. Test the redirect. Put the id into your config as above, then sign in twice:

   ```sh
   mail config set --defaults microsoft_client_id <application-client-id>
   mail outlook-test session start --address <your-address>@outlook.com
   mail outlook-test session start
   ```

   Both must end with `signed_in: true`. If Microsoft's page shows an error with `AADSTS50011` (the redirect URI does
   not match), check that the address under **Mobile and desktop applications** is exactly `http://localhost/callback`.
9. For WireCat's own app: send the Application (client) ID to the maintainers. They put it into
   `WIRECAT_MICROSOFT_CLIENT_ID` in `src/oauth.ts`, and the next release signs in without any config.

## Later, and not needed to start

- **Publisher verification** puts a verified badge on the consent page, and some organisations allow only verified
  apps. It is free, but it needs a Microsoft AI Cloud Partner Program account and a verified custom domain
  ([publisher verification](https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview)).
  Until then a Microsoft 365 user whose admin restricts consent asks the admin to approve the app, or to register the
  organisation's own app with these steps and give them its id.
- **Sending from Microsoft 365** needs "Authenticated SMTP" on for the mailbox. Security defaults, and organisations
  created after January 2020, turn it off; an admin turns it on per mailbox
  ([SMTP AUTH](https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/authenticated-client-smtp-submission)).
  Reading works either way.

## What the sign-in asks for

| Scope | What `mail` does with it |
|---|---|
| `https://outlook.office.com/IMAP.AccessAsUser.All` | read and change the mail over IMAP |
| `https://outlook.office.com/SMTP.Send` | send mail as the account over SMTP |
| `offline_access` | a refresh token, so a scheduled sync needs no new sign-in |

The tokens stay in the system keyring of the computer that signed in, as the app passwords do. `mail <profile> session
end` forgets them; Microsoft keeps listing the app until you remove it at
<https://account.live.com/consent/Manage> (personal account) or <https://myapps.microsoft.com> (work or school).
