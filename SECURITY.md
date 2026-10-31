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
`autoconfig.<domain>`, to find the server. `--provider` or `--host` skips those lookups.

Security audits of `mail` follow the shared
[security method](https://github.com/WireCatLabs/cli-testing/tree/main/docs/security) in cli-testing.
