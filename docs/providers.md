# Prepare the mailbox

<!-- Generated from src/providers.ts by pnpm generate. Do not edit. -->

Use this page before `mail setup`, which asks for the app password. Each provider needs IMAP on and, for most, an app password:
a password made only for this program. At the end you have an app password ready to type at the prompt.

`mail setup <address>` and `mail <profile> session start` print these same steps, and `session start` repeats the
likely cause when the server refuses the login. The steps below were read from each provider's official help page,
named under every provider. Labels are quoted in the language of the provider's interface. A provider can change
its screens; the help page is the source of truth.

## Yandex

1. Open <https://mail.yandex.ru/#setup/client> (or the gear, «Все настройки», «Почтовые программы»).
2. Under «Разрешить доступ к почтовому ящику с помощью почтовых клиентов» turn on «С сервера imap.yandex.ru по протоколу IMAP».
3. Make sure «Пароли приложений и OAuth токены» is on, then save.
4. Open <https://id.yandex.ru/security>, tab «Безопасность», section «Доступ к вашим данным», «Пароли приложений».
5. Under «Создать пароль приложения» choose the type «Почта», give the password a name and click «Далее».
6. Copy the password at once: Yandex shows it only once.

- A new app password starts working 2 to 3 hours after it is created (Yandex ID help).
- On a Yandex 360 business domain an administrator setting might block app passwords. The help pages do not confirm this; ask the domain administrator if the login keeps failing.

Read from: <https://yandex.ru/support/yandex-360/customers/mail/ru/mail-clients/others>, <https://yandex.ru/support/id/ru/authorization/app-passwords>

## Gmail

1. Personal Google Account: IMAP is always on, nothing to switch. Google Workspace: the administrator controls it, and the "Forwarding and POP/IMAP" tab in Gmail Settings, "See all settings", may be missing.
2. Turn on 2-Step Verification for the Google Account.
3. Open <https://myaccount.google.com/apppasswords> and create an app password. Google's help page does not list the labels of that screen, so none are quoted here.
4. Copy the 16 digit password and use it instead of the account password.

- App passwords are not offered if 2-Step Verification is set up only for security keys, on a work or school account, or with Advanced Protection on.

Read from: <https://support.google.com/mail/answer/7126229>, <https://support.google.com/accounts/answer/185833>

## iCloud

1. Turn on two-factor authentication for the Apple Account.
2. Go to <https://account.apple.com> and sign in.
3. In the "Sign In and Security" section select "App Specific Passwords".
4. Select "Generate an app specific password" and follow the on-screen steps.
5. Copy the password when it appears; Apple's page does not say whether it can be shown again.

- `mail` logs in with the full address. Apple says the name before @icloud.com is the usual login; if the full address is refused, run `mail setup <address> --login <name> --replace`.

Read from: <https://support.apple.com/en-us/102654>, <https://support.apple.com/en-us/102525>

## Mail.ru

1. Open <https://e.mail.ru/inbox>.
2. Bottom left click «Настройки», then «Все настройки», «Безопасность», «Пароли для внешних приложений».
3. Click «Создать», enter a name and click «Продолжить».
4. Choose «Полный доступ к Почте» as the protocol type and click «Продолжить».
5. Copy the password: Mail.ru does not keep it, so it cannot be viewed later.

- Mail.ru's help page requires a phone number linked to the mailbox (check it under «Контакты и адреса»). It lists no separate IMAP switch, only the server data.

Read from: <https://help.mail.ru/mail/login/mailer/>

## Fastmail

1. In the Fastmail web interface go to Settings, "Privacy & Security".
2. In "Connected apps & API tokens" click "Manage app passwords and access".
3. Click "New app password" (if "Verify it's you" appears, enter your password and click "Continue").
4. Pick a name, and keep the access "Mail, Contacts & Calendars", which includes IMAP.
5. Click "Generate password", copy it, then click "Done".

- Fastmail's Basic plans cannot create app passwords.

Read from: <https://www.fastmail.help/hc/en-us/articles/360058752854-App-passwords>

## Outlook

1. Outlook.com: open Settings (the cog), "Mail", "Forwarding and IMAP", turn on "Let devices and apps use IMAP" and save.
2. Microsoft's page lists only OAuth2 (Modern Auth) for IMAP and does not list app passwords for it. OAuth sign-in comes in a later phase of `mail`, so a profile cannot be saved yet.

- Microsoft 365 work and school accounts were not read from an official page: their steps are unverified.

Read from: <https://support.microsoft.com/en-us/office/pop-imap-and-smtp-settings-for-outlook-com-d088b986-291d-42b8-9564-9c414e2aa040>

## Any other provider

Make sure IMAP is on for the mailbox and, if the provider offers app passwords, make one: a normal password is often refused.

`setup` finds the server through the MX record, Thunderbird's ISPDB and the domain's autoconfig file. If it finds
none, pass `--host`, `--port` and `--security` yourself. See [use it](usage.md).
