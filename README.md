# mail

`mail` reads a mailbox over IMAP into the shared WireCat store, so memo and other tools can search it. It signs in with
an app password kept in the OS keyring. Its design is in [docs/dev/DESIGN.md](docs/dev/DESIGN.md).

## Quick start

```sh
npm install -g @wirecat/mail-cli
mail ya session start --address me@example.com
mail ya account check
mail ya sync
```

`session start` signs a profile in. For a new profile it finds the server from `--address`, saves the profile, asks
for the app password with no echo and keeps it in the keyring. It prints the steps to prepare the mailbox first (turn
on IMAP, make an app password); [the steps for every provider](https://github.com/WireCatLabs/mail-cli/blob/main/docs/providers.md) are in
`docs/providers.md`. Every command that uses a mailbox starts with its profile: `mail ya folders list`.
