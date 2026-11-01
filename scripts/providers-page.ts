import { GENERIC_PREPARE, PROVIDER_KEYS, PROVIDERS, type ProviderKey } from "../dist/providers.js"

const section = (key: ProviderKey): string => {
  const { name, prepare } = PROVIDERS[key]
  const { steps, notes, sources } = prepare
  return [
    `## ${name}`,
    "",
    ...steps.map((step, index) => `${index + 1}. ${step.replace(/https:\/\/[^\s),]*[^\s),.]/g, "<$&>")}`),
    "",
    ...notes.map((note) => `- ${note}`),
    ...(notes.length ? [""] : []),
    `Read from: ${sources.map((url) => `<${url}>`).join(", ")}`,
    "",
  ].join("\n")
}

export const providersPage = (): string =>
  [
    "# Prepare the mailbox",
    "",
    "<!-- Generated from src/providers.ts by pnpm generate. Do not edit. -->",
    "",
    "Use this page before `mail <profile> session start`, which asks for the app password. Each provider needs IMAP on and, for most, an app password:",
    "a password made only for this program. At the end you have an app password ready to type at the prompt.",
    "",
    "`mail <profile> session start` prints these same steps and repeats the",
    "likely cause when the server refuses the login. The steps below were read from each provider's official help page,",
    "named under every provider. Labels are quoted in the language of the provider's interface. A provider can change",
    "its screens; the help page is the source of truth.",
    "",
    ...PROVIDER_KEYS.map(section),
    "## Any other provider",
    "",
    GENERIC_PREPARE.notes.join(" "),
    "",
    "`session start` finds the server of a new profile through the MX record, Thunderbird's ISPDB and the domain's autoconfig file. If it finds",
    "none, pass `--host`, `--port` and `--security` yourself. See [use it](usage.md). Those lookups send the domain of the address, never the",
    "address itself, to your DNS resolver, to `autoconfig.thunderbird.net` and to `autoconfig.<domain>`; `--provider` or `--host` skips them.",
    "",
  ].join("\n")
