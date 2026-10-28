# mail — working rules

The [WireCat CLI standards](node_modules/@wirecat/cli-base/docs/standards/README.md) apply here and win over this
file; it keeps only the rules of `mail` itself. Start with [AGENTS.md](AGENTS.md).

**What cli-core already does, this repository does not do again** — commands, the store, search, MCP and the
permissions. A gap in cli-core is fixed in cli-core.

## Local rules

- **Before `1.0.0`, `Added` raises the minor too.** This narrows the handbook's
  [WC-REL-7](node_modules/@wirecat/cli-base/docs/standards/releases.md): the levels are in step 6 of the
  [release skill](docs/dev/skills/release/SKILL.md), and `pnpm version:check` refuses a version raised too little.

Add a rule here only when it holds for `mail` alone, and link the handbook rule it narrows.

## Private working folder

Plans, research and journals do not go into this repository. For WireCat's own CLIs they live in the private
repository `WireCatLabs/cli-private`, linked or cloned into `docs_ai/`, which git ignores. Elsewhere, keep them in a
folder of your own outside the repository.
