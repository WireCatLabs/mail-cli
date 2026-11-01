# Gmail with your own Google app

Gmail works with an app password, and `mail` uses one by default. Use OAuth instead when you cannot make an app
password: no 2-Step Verification on the account, or a Google Workspace domain that turns app passwords off. `mail` has
no Google app of its own for mail (Google requires a paid security review for an app that reads mail for others), so
you sign in through an app you create. It takes about 20 minutes and costs nothing.

## 1. A Google Cloud project just for mail

Open [Google Cloud Console](https://console.cloud.google.com/) and choose **New Project** in the project selector.
Name it, for example, `mail for me`, and keep it selected for every step below.

Use a new project even if you already have one for `drive` or `gcal`. When a sign-in is revoked, Google removes every
permission given to that project, for every app in it
([installed apps](https://developers.google.com/identity/protocols/oauth2/native-app)): a shared project would sign
`drive` and `gcal` out too.

## 2. Consent screen

Open **☰ → Google Auth platform → Branding** ([direct link](https://console.cloud.google.com/auth/branding)) and
choose **Get Started**. Give an app name (`mail for me`), your address as the support and contact email, and the
**External** audience (or **Internal** for a Workspace account that only you use). Create it.

## 3. Permission

Open **Google Auth platform → Data Access** ([direct link](https://console.cloud.google.com/auth/scopes)), choose
**Add or Remove Scopes**, and add `https://mail.google.com/` by hand in the manual entry field. Save. It is the only
scope Gmail gives IMAP and SMTP ([XOAUTH2](https://developers.google.com/workspace/gmail/imap/xoauth2-protocol)).
`mail` also asks for `openid` and `email`, to check that you signed in with the right account.

Google's page does not say whether the Gmail API must be enabled for IMAP alone. If the sign-in works and
`session status --check` then fails, enable the
[Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com) in this project and try again.

## 4. Publish the app (Production), without verification

Open **Google Auth platform → Audience** ([direct link](https://console.cloud.google.com/auth/audience)) and choose
**Publish app**, then confirm. Do not submit it for verification.

While an External app is in **Testing**, Google ends its sign-ins after 7 days
([refresh token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)), and a scheduled sync
stops once a week. A published app keeps the sign-in. Google does not ask a personal app with fewer than 100 users to
be verified ([exceptions](https://support.google.com/cloud/answer/13464323)); at sign-in it shows "Google hasn't
verified this app": choose **Advanced**, then **Go to mail for me (unsafe)**. It is your own app.

If you keep the app in Testing, add your address under **Test users**, and expect to run `session start` every week;
`mail doctor` warns from the sixth day.

## 5. Desktop client

Open **Google Auth platform → Clients** ([direct link](https://console.cloud.google.com/auth/clients)), choose
**Create Client**, **Application type → Desktop app**, a name, and **Create**. Choose **Download JSON** and save the
file outside any repository. Make it readable by you only, or `mail` refuses it:

```sh
chmod 600 ~/Downloads/client_secret_*.json
```

The file names the app; it is not your access. `mail` reads it once, at sign-in, and keeps the app's id and secret with
the tokens in the keyring.

## 6. Sign in

A new profile:

```sh
mail gm session start --address me@gmail.com --auth oauth --client-file ~/Downloads/client_secret_XXXX.json
```

A Gmail profile that has an app password now: switch it first, in a terminal (an agent cannot change `auth`):

```sh
mail gm config set auth oauth
mail gm session start --client-file ~/Downloads/client_secret_XXXX.json
```

The browser opens Google's page. Choose the account, allow access, and `mail` checks the address and logs in to IMAP
before it saves anything. `MAIL_GOOGLE_CLIENT_ID` and `MAIL_GOOGLE_CLIENT_SECRET` can stand in for `--client-file`.

## Signing out

`mail gm session end` forgets the sign-in on this computer and keeps the mail. `--revoke` also asks Google to revoke
it, which removes every permission of the whole Google project; with a project only for mail, that is just `mail`.
