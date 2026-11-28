### Added

- **WireCat Desktop can run this tool's MCP server.** The manifest names the server's port, 8753, so Desktop starts
  and stops the server from the tool page, like the other WireCat tools. Before, Desktop had no port for it and offered
  no server. It needs a Desktop that reads the port from the manifest.
- **The manifest says how Desktop signs in and how often it syncs.** Three sign-in methods, as Desktop's own list has
  them: Microsoft, Gmail and another mail server, each `{profile} session start --json --answer-stdin` with
  `--address`. Gmail also takes `--client-file` and `--method oauth`, and Microsoft names the `microsoft_client_id`
  setting. The sync timer starts at every 5 minutes, with choices from 5 minutes to 24 hours. Desktop keeps its own
  list only as a fallback.
- **Built on cli-base 1.2.0** (was 1.0.0), which writes the port, the sign-in methods and the timer into the manifest.
