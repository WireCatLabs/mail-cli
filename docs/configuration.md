# Settings

Settings live in one file, `config.json`, in the folder `mail doctor` shows. Each profile has its own part,
and `defaults` apply to every profile. This page lists how to see and change them.

```sh
mail personal config show
mail personal config set limit 50
mail personal config unset limit
```

`config show` lists each setting and where it came from: the file, a variable or the default.

## Permissions

`permissions` decides what a command may do for this profile: `allow`, `ask`, `readonly` or `deny`, per permission
key. Over MCP there is no one to ask, so `ask` lets the command run. `MAIL_READ_ONLY=1` refuses every write, whatever
the permissions say.

## Run records

A command that fails is kept as a run, for `mail runs list` and `runs show`. `record_input` decides whether a run
keeps the words you typed; it is `true` unless you set it to `false`. Secrets are masked either way; see
[Security](security.md).
