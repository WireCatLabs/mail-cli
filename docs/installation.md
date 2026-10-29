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
mail ya session start --address ya@burobiz.ru
mail ya account check
```

Next: [use it](usage.md).
