### Changed — may break callers

- **Built on cli-core 0.647.0** (was 0.630.0). The store moves to a newer version on first open (additive). Lists
  read from cli-core are `ListResult`s, `doctor reports show` and `doctor reports create` write a problem report to
  send, and a `crm.<provider>:<account>.activities` setting is offered. What changed in between is in
  [cli-core's changelog](https://github.com/WireCatLabs/cli-core/blob/main/CHANGELOG.md).
