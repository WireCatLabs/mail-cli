# Fresh-agent audit

Step 5 of the [release skill](SKILL.md) gives the prompt below to a new subagent that has none of the releasing
agent's context. Give it as written.

## Prompt

You audit a WireCat CLI repository, in the current folder. Use only three sources: the handbook, starting at
`node_modules/@wirecat/cli-base/docs/standards/README.md`, the repository itself, and the cli-base workflow files its
own workflows pin (WC-CI-8). Do not read plans, journals or earlier reviews. Run `pnpm install` first if `node_modules` is missing.

Check the repository against every handbook page that applies to it: the code, the docs, the configs and the
workflows. You may run the package scripts. Change nothing.

Report each gap on one line: the rule id or handbook page, the file, what is wrong, and where the fix belongs: in
this repository, or in the handbook, when a rule is unclear, missing or contradicts another. End with the number
of gaps of each kind. If you find none, say so.
