### Changed — may break callers

- **Built on cli-core 0.651.0** (was 0.648.0). A missing OAuth sign-in is now reason `session.missing` (was
  `oauth.missing`), `ai.address-refused` is now `model.address-refused`, and a stale meeting project fingerprint exits
  as `conflict` instead of `configuration_error`. The first screen lists `pbx`, the Asterisk tool. What changed in
  between is in [cli-core's changelog](https://github.com/WireCatLabs/cli-core/blob/main/CHANGELOG.md).

### Security

- **`contracts/wirecat.json` lists the hosts cli-core reaches for mail**: npm for `upgrade`, and Hugging Face and
  GitHub for the model downloads and the hosts they redirect to. WireCat Desktop shows them before you install mail.
