# Reporting a vulnerability

Please report a security problem privately — never in a public issue:

- by email: [hello@wirecat.dev](mailto:hello@wirecat.dev);
- or through [GitHub's private vulnerability reporting](https://github.com/WireCatLabs/mail-cli/security/advisories/new).

Say what you saw, how to repeat it, and the version (`mail --version`). Never send a token, a password, a session or
anyone's private content.

What `mail` keeps on your computer: the [shared security page](https://wirecat.dev/en/docs/security) and
[docs/security.md](docs/security.md).

What leaves your computer besides the login to your mail server: `session start` on a new profile sends the domain of
the address, never the address itself, to your DNS resolver, to `autoconfig.thunderbird.net` and to
`autoconfig.<domain>`, to find the server. `--provider` or `--host` skips those lookups. `sync` and
`account inspect --domain-age` ask when a sender's domain was registered: IANA's list of registries
(`data.iana.org`, once a month), then that domain's own registry over RDAP. They send the domain, never an address,
and never ask about a big mailbox provider's domain or a sender you replied to.

Security audits of `mail` follow the shared
[security method](https://github.com/WireCatLabs/cli-testing/tree/main/docs/security) in cli-testing.
