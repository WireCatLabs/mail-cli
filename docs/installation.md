# Install

Install `mail` once on each computer where you or an agent use it. You need Node.js 22.16 or a later 22.x, or 24 or later; Node 23 is not supported.

```sh
npm install -g @wirecat/mail-cli
mail --version
```

Check the installation:

```sh
mail doctor
```

`doctor` needs no network and opens no keyring. It shows the version, where settings live, the profiles that
exist, and whether other users of the computer can read the settings.

Then connect a mailbox. You choose the profile name, the first word of every command:

```sh
mail ya session start --address me@example.com
mail ya account check
```

## Search your mail

After `sync`, the mail is in the shared store, and `mail` searches it:

```sh
mail ya search messages invoice
```

The query words are in [use it](usage.md#search-your-mail). [memo](https://github.com/WireCatLabs/cli-memo) searches
every mailbox together with your messages and notes.

Next: [use it](usage.md).
