import { GMAIL_ALL_MAIL } from "@wirecat/cli-core/mail"

export const PROVIDERS_URL = "https://github.com/WireCatLabs/mail-cli/blob/main/docs/providers.md"

export type Security = "tls" | "starttls"

export interface Endpoint {
  host: string
  port: number
  security: Security
}

export interface Prepare {
  /** What the person does in the provider's own settings, in order. UI labels are quoted in the provider's language. */
  steps: string[]
  notes: string[]
  /** Why a refused login is likely, said right after the server rejects it. */
  refused: string
  /** The official help pages the steps were read from. */
  sources: string[]
}

/** Which folders `sync` reads when neither the profile nor `--folder` names any: by role, else the named one. */
export interface SyncFolders {
  /** `gmail`: one All Mail with labels, as memo syncs it, so both tools keep the same saved position. */
  mode?: "gmail"
  roles: string[]
  otherwise: string
}

/** How a change reaches the mailbox, where providers differ. */
export interface Organise {
  /** Gmail: one All Mail with labels, so a move or copy is a change of labels, and a deletion a move to Trash. */
  labels?: true
  /** Trash under the names the provider gives it, tried when the server marks no folder `\Trash`. */
  trash: string[]
}

/** Where `messages send` submits mail, read from the provider's own help page. */
export interface Smtp extends Endpoint {
  /**
   * The server files what SMTP carried into Sent itself, so a copy appended by the tool would be a second one. Absent:
   * the help page does not say so, and the tool appends the copy unless Sent already holds that Message-ID.
   */
  savesSent?: true
  sources: string[]
}

export interface Provider {
  name: string
  /** Address domains it hosts; every provider here logs in with the full address. */
  domains: string[]
  /** A domain with its own name can still be hosted here: its MX record says where. */
  mx?: RegExp
  imap: Endpoint
  smtp: Smtp
  auth: "app-password" | "oauth"
  note?: string
  sync?: SyncFolders
  organise?: Organise
  prepare: Prepare
}

const tls = (host: string, port = 993): Endpoint => ({ host, port, security: "tls" })

const YANDEX_CLIENTS = "https://yandex.ru/support/mail/mail-clients/others.html"
const OUTLOOK_SETTINGS =
  "https://support.microsoft.com/en-us/office/pop-imap-and-smtp-settings-for-outlook-com-d088b986-291d-42b8-9564-9c414e2aa040"

const TABLE = {
  yandex: {
    name: "Yandex",
    domains: ["yandex.ru", "yandex.com", "ya.ru", "yandex.by", "yandex.kz", "yandex.ua"],
    mx: /(^|\.)mx\.yandex\.(net|ru)$|(^|\.)yandex\.(net|ru)$/,
    imap: tls("imap.yandex.com"),
    smtp: { ...tls("smtp.yandex.ru", 465), sources: [YANDEX_CLIENTS] },
    auth: "app-password",
    note: "turn on IMAP and app passwords in Yandex settings, then make a password of type Mail",
    organise: { trash: ["Trash", "Удалённые", "Удаленные"] },
    prepare: {
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
  },
  gmail: {
    name: "Gmail",
    domains: ["gmail.com", "googlemail.com"],
    mx: /(^|\.)(aspmx\.l\.google\.com|googlemail\.com|google\.com)$/,
    imap: tls("imap.gmail.com"),
    smtp: {
      ...tls("smtp.gmail.com", 465),
      // "Sent messages are automatically copied to the Gmail/Sent folder if your email client uses SMTP."
      savesSent: true,
      sources: [
        "https://knowledge.workspace.google.com/admin/gmail/send-email-from-a-printer-scanner-or-app",
        "https://support.google.com/mail/answer/78892",
      ],
    },
    auth: "app-password",
    note: "needs 2-step verification and an app password; IMAP downloads are capped at 2500 MB a day",
    // Archived mail leaves INBOX; read from INBOX alone it would look deleted.
    sync: { mode: "gmail", roles: ["all"], otherwise: GMAIL_ALL_MAIL },
    organise: { labels: true, trash: ["[Gmail]/Trash", "[Google Mail]/Trash"] },
    prepare: {
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
  },
  icloud: {
    name: "iCloud",
    domains: ["icloud.com", "me.com", "mac.com"],
    imap: tls("imap.mail.me.com"),
    smtp: {
      host: "smtp.mail.me.com",
      port: 587,
      security: "starttls",
      sources: ["https://support.apple.com/en-us/102525"],
    },
    auth: "app-password",
    note: "needs an app-specific password",
    prepare: {
      steps: [
        "Turn on two-factor authentication for the Apple Account.",
        "Go to https://account.apple.com and sign in.",
        'In the "Sign In and Security" section select "App Specific Passwords".',
        'Select "Generate an app specific password" and follow the on-screen steps.',
        "Copy the password when it appears; Apple's page does not say whether it can be shown again.",
      ],
      notes: [
        "`mail` logs in with the full address. Apple says the name before @icloud.com is the usual login; if the full address is refused, sign in with a new profile name: `mail <profile> session start --address <address> --login <name>`.",
      ],
      refused:
        "the password may be the Apple Account password instead of an app specific password, or the login may need the name before @icloud.com (--login).",
      sources: ["https://support.apple.com/en-us/102654", "https://support.apple.com/en-us/102525"],
    },
  },
  mailru: {
    name: "Mail.ru",
    domains: ["mail.ru", "inbox.ru", "list.ru", "bk.ru", "internet.ru"],
    mx: /(^|\.)mail\.ru$/,
    imap: tls("imap.mail.ru"),
    smtp: { ...tls("smtp.mail.ru", 465), sources: ["https://help.mail.ru/mail/login/mailer/"] },
    auth: "app-password",
    note: "needs an app password for external programs",
    prepare: {
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
  },
  fastmail: {
    name: "Fastmail",
    domains: ["fastmail.com", "fastmail.fm"],
    mx: /(^|\.)messagingengine\.com$/,
    imap: tls("imap.fastmail.com"),
    smtp: {
      ...tls("smtp.fastmail.com", 465),
      sources: ["https://www.fastmail.help/hc/en-us/articles/1500000278342-Server-names-and-ports"],
    },
    auth: "app-password",
    prepare: {
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
  },
  outlook: {
    name: "Outlook",
    domains: ["outlook.com", "hotmail.com", "live.com"],
    mx: /\.mail\.protection\.outlook\.com$/,
    imap: tls("outlook.office365.com"),
    smtp: { host: "smtp-mail.outlook.com", port: 587, security: "starttls", sources: [OUTLOOK_SETTINGS] },
    auth: "oauth",
    note: "Microsoft accepts only OAuth for IMAP; an app password cannot work, wait for OAuth sign-in",
    prepare: {
      steps: [
        'Outlook.com: open Settings (the cog), "Mail", "Forwarding and IMAP", turn on "Let devices and apps use IMAP" and save.',
        "Microsoft's page lists only OAuth2 (Modern Auth) for IMAP and does not list app passwords for it. OAuth sign-in comes in a later phase of `mail`, so a profile cannot be saved yet.",
      ],
      notes: [
        "Microsoft 365 work and school accounts were not read from an official page: their steps are unverified.",
      ],
      refused: "Microsoft accepts only OAuth for IMAP, which this version cannot do yet.",
      sources: [OUTLOOK_SETTINGS],
    },
  },
} satisfies Record<string, Provider>

export type ProviderKey = keyof typeof TABLE

/** One entry per built-in provider: how it is found, its servers, how it signs in and how to prepare it. */
export const PROVIDERS: Record<ProviderKey, Provider> = TABLE

export const PROVIDER_KEYS = Object.keys(PROVIDERS) as ProviderKey[]

export const providerByDomain = (domain: string): ProviderKey | undefined =>
  PROVIDER_KEYS.find((key) => PROVIDERS[key].domains.includes(domain))

export const DEFAULT_SYNC: SyncFolders = { roles: ["inbox", "sent"], otherwise: "INBOX" }

export const DEFAULT_ORGANISE: Organise = { trash: ["Trash", "Deleted Items", "Deleted Messages"] }

/** The provider of a saved profile: its address domain first, then its server host (a domain of its own on Yandex). */
export const providerFor = (address: string, host: string | undefined): Provider | undefined => {
  const domain = address.split("@")[1]?.toLowerCase() ?? ""
  const key = providerByDomain(domain) ?? PROVIDER_KEYS.find((name) => PROVIDERS[name].imap.host === host)
  return key === undefined ? undefined : PROVIDERS[key]
}

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
