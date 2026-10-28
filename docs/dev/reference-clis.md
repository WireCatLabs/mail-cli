# Reference CLIs

The template has no sample code. The agent that builds a new CLI learns from the WireCat CLI closest to it, picked by
the first question of the [design interview](skills/design-interview/SKILL.md):

| Category | Learn from |
| --- | --- |
| messenger | [whatsapp-cli](https://github.com/WireCatLabs/whatsapp-cli), then [tg-cli](https://github.com/WireCatLabs/tg-cli) and [max-cli](https://github.com/WireCatLabs/max-cli) |
| files and documents | [drive-cli](https://github.com/WireCatLabs/drive-cli) |
| meetings | [zoom-cli](https://github.com/WireCatLabs/zoom-cli) |
| notes | [cli-memo](https://github.com/WireCatLabs/cli-memo) |
| mail, calendar, other | none of its own yet: pick the nearest one with the owner. cli-memo [imports mail](https://github.com/WireCatLabs/cli-memo/blob/c2d21254ab360aed7149a3250d17e879283aa603/docs/mail.md) |

A messenger CLI sets `messenger: true` in `src/identity.ts`, and `new --category messenger` writes it. Every other
category keeps the template's `messenger: false`, so the shared help and `commands` do not speak of chats, messages
and senders. `config` still lists cli-core's messenger settings, such as `sends_per_hour` and `read_other_bots`.

cli-core keeps a provider registry (WC-ARCH-21). A CLI whose provider is not built into cli-core writes its entry on
every run that opens the shared store: `await store.accounts.registerProvider({ name, kind, aliases, command })`, on the
store that `openStore` from `@wirecat/cli-core/store` returns
([`AccountsStore`](https://github.com/WireCatLabs/cli-core/blob/185718d3212cda9bb026e09809760979fe31a1e6/src/store/accounts.ts#L40-L41),
cli-core 0.459.0). `@wirecat/cli-core/store` does not export a `registerProvider` function. `kind` is one of
`messages`, `mail`, `notes`, `documents`, `meetings` or `events`. Until the CLI has run once on a computer, `search`
there leaves its accounts out and lists them under `skipped`. Of the reference CLIs, none makes this call: cli-core
already knows their providers, from its
[seed list](https://github.com/WireCatLabs/cli-core/blob/185718d3212cda9bb026e09809760979fe31a1e6/src/domain/providers.ts#L17-L29)
and, for Drive, its
[document providers](https://github.com/WireCatLabs/cli-core/blob/185718d3212cda9bb026e09809760979fe31a1e6/src/domain/providers.ts#L50).
[gcal-cli](https://github.com/WireCatLabs/gcal-cli/blob/14e27c45e6dc204cde8adcd9e4fa6aa069745335/src/store.ts) does. The skeleton opens no store and
has no provider, so it registers nothing; the call comes with the CLI's first store code.
