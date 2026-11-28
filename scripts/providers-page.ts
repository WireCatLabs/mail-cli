import { GENERIC_PREPARE, PROVIDERS, type ProviderKey } from "../dist/providers.js"

// International providers first. Mail.ru is documented only in the Russian translation of this page.
const PAGE_ORDER: ProviderKey[] = ["gmail", "outlook", "microsoft365", "icloud", "fastmail", "yandex"]

const section = (key: ProviderKey): string => {
  const { name, prepare, smtp, auth } = PROVIDERS[key]
  const { steps, notes, sources } = prepare
  return [
    `## ${name}`,
    "",
    ...steps.map((step, index) => `${index + 1}. ${step.replace(/https:\/\/[^\s),]*[^\s),.]/g, "<$&>")}`),
    "",
    ...notes.map((note) => `- ${note}`),
    ...(notes.length ? [""] : []),
    ...(key === "gmail"
      ? ["Or skip the app password: sign in with Google ([Gmail with Google sign-in](oauth-google.md)).", ""]
      : []),
    `Help: ${sources.map((url) => `<${url}>`).join(", ")}`,
    "",
    `Sending: \`${smtp.host}\` port ${smtp.port}, ${smtp.security === "tls" ? "TLS" : "STARTTLS"}, ${auth === "oauth" ? "with the same OAuth sign-in" : "with the same app password"}. ` +
      (smtp.savesSent ? "The provider files sent mail in Sent itself." : "`mail` puts a copy in Sent.") +
      ` Help: ${smtp.sources.map((url) => `<${url}>`).join(", ")}`,
    "",
  ].join("\n")
}

export const providersPage = (): string =>
  [
    "# Prepare the mailbox",
    "",
    "<!-- Generated from src/providers.ts by pnpm generate. Do not edit. -->",
    "",
    "Get your mailbox ready for `mail personal session start`, which asks for the app password, or for Outlook.com and Microsoft 365 opens Microsoft's sign-in in the browser. Each provider needs IMAP on and, for most, an app password:",
    "a password made only for this program. At the end you have an app password ready to type at the prompt.",
    "",
    "`mail personal session start` prints these same steps and repeats the likely cause when the server refuses the",
    "login. Labels are quoted as the provider's own screens show them. If a screen differs, the provider's help page",
    "under each section has the current steps.",
    "",
    "**On this page:**",
    "",
    ...[...PAGE_ORDER.map((key) => PROVIDERS[key].name), "Any other provider"].map(
      (name, index) => `${index + 1}. [${name}](#${name.toLowerCase().replaceAll(" ", "-")})`,
    ),
    "",
    ...PAGE_ORDER.map(section),
    "## Any other provider",
    "",
    GENERIC_PREPARE.notes.join(" "),
    "",
    "`session start` finds the server of a new profile through the MX record, Thunderbird's ISPDB and the domain's autoconfig file. If it finds",
    "none, pass `--host`, `--port` and `--security` yourself, and for sending set `smtp_host`, `smtp_port` and `smtp_security` with `config set`. See [everyday use](usage.md). Those lookups send the domain of the address, never the",
    "address itself, to your DNS resolver, to `autoconfig.thunderbird.net` and to `autoconfig.<domain>`; `--provider` or `--host` skips them.",
    "",
  ].join("\n")
