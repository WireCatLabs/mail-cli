# Working rules for agents

The [WireCat CLI standards](node_modules/@wirecat/cli-base/docs/standards/README.md) apply here and win over this
file and over every other document in this repository. The handbook ships inside `@wirecat/cli-base`; run
`pnpm install` first. Read the page for the area you change before changing it, and cite the rule ids the change
touches (`WC-<AREA>-<n>`) in the commit message and the pull request. The rules of this CLI alone are in
[CLAUDE.md](CLAUDE.md).

## Design

[docs/dev/DESIGN.md](docs/dev/DESIGN.md) holds the owner's answers to the
[design interview](docs/dev/skills/design-interview/SKILL.md) and the decisions made since. Read it before changing
what a command does, and write a new decision there. Learn the patterns for the provider, the store and the commands
from the reference CLI below; the template has no sample code on purpose.

<!-- cli-template:reference-cli:start -->
## Reference CLI

No reference CLI for this category yet: pick the nearest one with the owner from the Reference CLIs page.
<!-- cli-template:reference-cli:end -->

## Template-owned files

This CLI was made from [cli-template](https://github.com/WireCatLabs/cli-template). `template.json` names the files
`npx @wirecat/cli-template upgrade` keeps in step with the template. Change one of them here only when this CLI needs
to differ; `upgrade` asks before it touches your change. Text that holds for this CLI alone goes into the pages it
owns, such as `DESIGN.md`, `CLAUDE.md` and `README.md`, not into a template-owned page.
