# Prepare the mailbox

<!-- Generated from src/providers.ts by pnpm generate. Do not edit. -->

Get your mailbox ready for `mail personal session start`, which asks for the app password, or for Outlook.com and Microsoft 365 opens Microsoft's sign-in in the browser. Each provider needs IMAP on and, for most, an app password:
a password made only for this program. At the end you have an app password ready to type at the prompt.

`mail personal session start` prints these same steps and repeats the likely cause when the server refuses the
login. Labels are quoted as the provider's own screens show them. If a screen differs, the provider's help page
under each section has the current steps.

**On this page:**

1. [Gmail](#gmail)
2. [Outlook](#outlook)
3. [Microsoft 365](#microsoft-365)
4. [iCloud](#icloud)
5. [Fastmail](#fastmail)
6. [Yandex](#yandex)
7. [Any other provider](#any-other-provider)

## Gmail

1. Personal Google Account: IMAP is always on, nothing to switch. Google Workspace: the administrator controls it, and the "Forwarding and POP/IMAP" tab in Gmail Settings, "See all settings", may be missing.
2. Turn on 2-Step Verification for the Google Account.
3. Open <https://myaccount.google.com/apppasswords> and create an app password.
4. Copy the 16-letter password and use it instead of the account password.

- App passwords are not offered if 2-Step Verification is set up only for security keys, on a work or school account, or with Advanced Protection on.

Or skip the app password: sign in with Google ([Gmail with Google sign-in](oauth-google.md)).

Help: <https://support.google.com/mail/answer/7126229>, <https://support.google.com/accounts/answer/185833>

Sending: `smtp.gmail.com` port 465, TLS, with the same app password. The provider files sent mail in Sent itself. Help: <https://knowledge.workspace.google.com/admin/gmail/send-email-from-a-printer-scanner-or-app>, <https://support.google.com/mail/answer/78892>

## Outlook

1. Outlook.com: open Settings (the cog), "Mail", "Forwarding and IMAP", turn on "Let devices and apps use IMAP" and save.
2. Then `mail` opens Microsoft's sign-in page in the browser: sign in and allow access. Outlook.com takes only OAuth for IMAP and SMTP, never an app password.

Help: <https://support.microsoft.com/en-us/office/pop-imap-and-smtp-settings-for-outlook-com-d088b986-291d-42b8-9564-9c414e2aa040>, <https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth>

Sending: `smtp-mail.outlook.com` port 587, STARTTLS, with the same OAuth sign-in. `mail` puts a copy in Sent. Help: <https://support.microsoft.com/en-us/office/pop-imap-and-smtp-settings-for-outlook-com-d088b986-291d-42b8-9564-9c414e2aa040>

## Microsoft 365

1. Nothing to prepare in the mailbox: `mail` opens Microsoft's sign-in page in the browser; sign in with the work or school account and allow access.

- Your organisation may let only an admin allow a new app. If Microsoft says an admin must approve it, ask your admin to grant consent, or to register the organisation's own app and give you its id.
- Sending needs "Authenticated SMTP" on for your mailbox; organisations with security defaults, and those created after January 2020, have it off until an admin turns it on. Reading works either way.
- The IMAP server for Microsoft 365 is outlook.office365.com, the same one Outlook.com uses.

Help: <https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth>, <https://learn.microsoft.com/en-us/exchange/mail-flow-best-practices/how-to-set-up-a-multifunction-device-or-application-to-send-email-using-microsoft-365-or-office-365>, <https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/authenticated-client-smtp-submission>, <https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-user-consent>

Sending: `smtp.office365.com` port 587, STARTTLS, with the same OAuth sign-in. `mail` puts a copy in Sent. Help: <https://learn.microsoft.com/en-us/exchange/mail-flow-best-practices/how-to-set-up-a-multifunction-device-or-application-to-send-email-using-microsoft-365-or-office-365>

## iCloud

1. Turn on two-factor authentication for the Apple Account.
2. Go to <https://account.apple.com> and sign in.
3. In the "Sign In and Security" section select "App Specific Passwords".
4. Select "Generate an app specific password" and follow the on-screen steps.
5. Copy the password when it appears.

- The sign-in uses the full address as the login. Apple says the name before @icloud.com is the usual login; if the full address is refused, sign in again under a new profile name and give the name before @icloud.com as the login.

Help: <https://support.apple.com/en-us/102654>, <https://support.apple.com/en-us/102525>

Sending: `smtp.mail.me.com` port 587, STARTTLS, with the same app password. `mail` puts a copy in Sent. Help: <https://support.apple.com/en-us/102525>

## Fastmail

1. In the Fastmail web interface go to Settings, "Privacy & Security".
2. In "Connected apps & API tokens" click "Manage app passwords and access".
3. Click "New app password" (if "Verify it's you" appears, enter your password and click "Continue").
4. Pick a name, and keep the access "Mail, Contacts & Calendars", which includes IMAP.
5. Click "Generate password", copy it, then click "Done".

- Fastmail's Basic plans cannot create app passwords.

Help: <https://www.fastmail.help/hc/en-us/articles/360058752854-App-passwords>

Sending: `smtp.fastmail.com` port 465, TLS, with the same app password. `mail` puts a copy in Sent. Help: <https://www.fastmail.help/hc/en-us/articles/1500000278342-Server-names-and-ports>

## Yandex

1. Open <https://mail.yandex.ru/#setup/client> (or the gear, «Все настройки», «Почтовые программы»).
2. Under «Разрешить доступ к почтовому ящику с помощью почтовых клиентов» turn on «С сервера imap.yandex.ru по протоколу IMAP».
3. Make sure «Пароли приложений и OAuth токены» is on, then save.
4. Open <https://id.yandex.ru/security>, tab «Безопасность», section «Доступ к вашим данным», «Пароли приложений».
5. Under «Создать пароль приложения» choose the type «Почта», give the password a name and click «Далее».
6. Copy the password at once: Yandex shows it only once.

- A new app password starts working 2 to 3 hours after it is created (Yandex ID help).
- If the login keeps failing on a Yandex 360 business domain, ask the domain administrator whether app passwords are allowed.

Help: <https://yandex.ru/support/yandex-360/customers/mail/ru/mail-clients/others>, <https://yandex.ru/support/id/ru/authorization/app-passwords>

Sending: `smtp.yandex.ru` port 465, TLS, with the same app password. `mail` puts a copy in Sent. Help: <https://yandex.ru/support/mail/mail-clients/others.html>

## Any other provider

Make sure IMAP is on for the mailbox and, if the provider offers app passwords, make one: a normal password is often refused.

`session start` finds the server of a new profile through the MX record, Thunderbird's ISPDB and the domain's autoconfig file. If it finds
none, pass `--host`, `--port` and `--security` yourself, and for sending set `smtp_host`, `smtp_port` and `smtp_security` with `config set`. See [everyday use](usage.md). Those lookups send the domain of the address, never the
address itself, to your DNS resolver, to `autoconfig.thunderbird.net` and to `autoconfig.<domain>`; `--provider` or `--host` skips them.
