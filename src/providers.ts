export const PROVIDERS_URL = "https://github.com/WireCatLabs/mail-cli/blob/main/docs/providers.md"

export interface Prepare {
  /** What the person does in the provider's own settings, in order. UI labels are quoted in the provider's language. */
  steps: string[]
  notes: string[]
  /** Why a refused login is likely, said right after the server rejects it. */
  refused: string
  /** The official help pages the steps were read from. */
  sources: string[]
}

export const PROVIDER_PREPARE = {
  yandex: {
    steps: [
      "Open https://mail.yandex.ru/#setup/client (or the gear, «Все настройки», «Почтовые программы»).",
      "Under «Разрешить доступ к почтовому ящику с помощью почтовых клиентов» turn on «С сервера imap.yandex.ru по протоколу IMAP».",
      "Make sure «Пароли приложений и OAuth токены» is on, then save.",
      "Open https://id.yandex.ru/security, tab «Безопасность», section «Доступ к вашим данным», «Пароли приложений».",
      "Under «Создать пароль приложения» choose the type «Почта», give the password a name and click «Далее».",
      "Copy the password at once: Yandex shows it only once.",
    ],
    notes: [
      "A new app password starts working 2 to 3 hours after it is created (Yandex ID help).",
      "On a Yandex 360 business domain an administrator setting might block app passwords. The help pages do not confirm this; ask the domain administrator if the login keeps failing.",
    ],
    refused:
      "IMAP may be off, the password may not be of type «Почта», or it may be under 2 to 3 hours old. Yandex 360 domains may also block app passwords.",
    sources: [
      "https://yandex.ru/support/yandex-360/customers/mail/ru/mail-clients/others",
      "https://yandex.ru/support/id/ru/authorization/app-passwords",
    ],
  },
  gmail: {
    steps: [
      'Personal Google Account: IMAP is always on, nothing to switch. Google Workspace: the administrator controls it, and the "Forwarding and POP/IMAP" tab in Gmail Settings, "See all settings", may be missing.',
      "Turn on 2-Step Verification for the Google Account.",
      "Open https://myaccount.google.com/apppasswords and create an app password. Google's help page does not list the labels of that screen, so none are quoted here.",
      "Copy the 16 digit password and use it instead of the account password.",
    ],
    notes: [
      "App passwords are not offered if 2-Step Verification is set up only for security keys, on a work or school account, or with Advanced Protection on.",
    ],
    refused:
      "2-Step Verification may be off, the password may be the account password instead of an app password, or the account type may not offer app passwords.",
    sources: ["https://support.google.com/mail/answer/7126229", "https://support.google.com/accounts/answer/185833"],
  },
  icloud: {
    steps: [
      "Turn on two-factor authentication for the Apple Account.",
      "Go to https://account.apple.com and sign in.",
      'In the "Sign In and Security" section select "App Specific Passwords".',
      'Select "Generate an app specific password" and follow the on-screen steps.',
      "Copy the password when it appears; Apple's page does not say whether it can be shown again.",
    ],
    notes: [
      "`mail` logs in with the full address. Apple says the name before @icloud.com is the usual login; if the full address is refused, run `mail setup <address> --login <name> --replace`.",
    ],
    refused:
      "the password may be the Apple Account password instead of an app specific password, or the login may need the name before @icloud.com (--login).",
    sources: ["https://support.apple.com/en-us/102654", "https://support.apple.com/en-us/102525"],
  },
  mailru: {
    steps: [
      "Open https://e.mail.ru/inbox.",
      "Bottom left click «Настройки», then «Все настройки», «Безопасность», «Пароли для внешних приложений».",
      "Click «Создать», enter a name and click «Продолжить».",
      "Choose «Полный доступ к Почте» as the protocol type and click «Продолжить».",
      "Copy the password: Mail.ru does not keep it, so it cannot be viewed later.",
    ],
    notes: [
      "Mail.ru's help page requires a phone number linked to the mailbox (check it under «Контакты и адреса»). It lists no separate IMAP switch, only the server data.",
    ],
    refused: "the password may not be one made under «Пароли для внешних приложений» with «Полный доступ к Почте».",
    sources: ["https://help.mail.ru/mail/login/mailer/"],
  },
  fastmail: {
    steps: [
      'In the Fastmail web interface go to Settings, "Privacy & Security".',
      'In "Connected apps & API tokens" click "Manage app passwords and access".',
      'Click "New app password" (if "Verify it\'s you" appears, enter your password and click "Continue").',
      'Pick a name, and keep the access "Mail, Contacts & Calendars", which includes IMAP.',
      'Click "Generate password", copy it, then click "Done".',
    ],
    notes: ["Fastmail's Basic plans cannot create app passwords."],
    refused:
      "the password may be the account password instead of an app password, or the plan may not allow app passwords.",
    sources: ["https://www.fastmail.help/hc/en-us/articles/360058752854-App-passwords"],
  },
  outlook: {
    steps: [
      'Outlook.com: open Settings (the cog), "Mail", "Forwarding and IMAP", turn on "Let devices and apps use IMAP" and save.',
      "Microsoft's page lists only OAuth2 (Modern Auth) for IMAP and does not list app passwords for it. OAuth sign-in comes in a later phase of `mail`, so a profile cannot be saved yet.",
    ],
    notes: ["Microsoft 365 work and school accounts were not read from an official page: their steps are unverified."],
    refused: "Microsoft accepts only OAuth for IMAP, which this version cannot do yet.",
    sources: [
      "https://support.microsoft.com/en-us/office/pop-imap-and-smtp-settings-for-outlook-com-d088b986-291d-42b8-9564-9c414e2aa040",
    ],
  },
} satisfies Record<string, Prepare>

export type ProviderKey = keyof typeof PROVIDER_PREPARE

export const GENERIC_PREPARE: Prepare = {
  steps: [],
  notes: [
    "Make sure IMAP is on for the mailbox and, if the provider offers app passwords, make one: a normal password is often refused.",
  ],
  refused: "IMAP may be off, or the provider may need an app password instead of the account password.",
  sources: [],
}

/** The human text for `setup` and `session start`; nothing in it comes from the mailbox or the password. */
export const prepareText = (provider: string, prepare: Prepare): string => {
  const head = prepare.steps.length ? `Prepare the ${provider} mailbox first:` : `About the ${provider} mailbox:`
  return [
    head,
    ...prepare.steps.map((step, index) => `  ${index + 1}. ${step}`),
    ...prepare.notes.map((line) => `  Note: ${line}`),
    ...(prepare.sources.length ? [`  Sources: ${prepare.sources.join(" ")}`] : []),
    `  All providers: ${PROVIDERS_URL}`,
  ].join("\n")
}
