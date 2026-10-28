# mail

`mail` reads a mailbox over IMAP into the shared WireCat store, so memo and other tools can search it. It signs in with
an app password kept in the OS keyring. Its design is in [docs/dev/DESIGN.md](docs/dev/DESIGN.md).

## Quick start

```sh
npm install -g @wirecat/mail-cli
mail setup ya@burobiz.ru --name ya
mail ya session start
mail ya account check
mail ya sync
```

`setup` finds the server and saves a profile after you confirm. `session start` asks for the app password with no
echo and keeps it in the keyring. Every command that uses a mailbox starts with its profile: `mail ya folders list`.
