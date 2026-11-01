#!/usr/bin/env bash
# `cli-dev audit` needs the other CLIs' command trees: this audits the built CLI beside the latest published ones of
# cli-base's "all" parity group, and fails only on a new finding that names this CLI.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
command=$(node --input-type=module -e "import('$root/dist/identity.js').then((m) => console.log(m.IDENTITY.command))")
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
# A CLI that starts may move the store under HOME; every CLI run here gets a throwaway one.
# Moved folders do not hide the keyring: it is reached over D-Bus.
export HOME="$scratch/home" MESSAGING_STORE="$scratch/store" WIRECAT_STATE_DIR="$scratch/state"
export DBUS_SESSION_BUS_ADDRESS=disabled:
mkdir -p "$HOME"
npm install -g --prefix "$scratch/prefix" --ignore-scripts --no-audit --no-fund --loglevel error \
  @wirecat/tg-cli @wirecat/max-cli @wirecat/whatsapp-cli @wirecat/cli-memo @wirecat/drive-cli @wirecat/zoom-cli \
  @wirecat/gcal-cli
bin="$scratch/prefix/bin"
others=()
names=()
for cli in tg max wa memo drive zm gcal; do
  [ "$cli" = "$command" ] || { others+=(--cli "$bin/$cli"); names+=("$cli"); }
done
# This CLI's entity schemas and error reasons, from its own `commands info`, so same-entity-schema and
# same-error-reason measure it.
node "$root/dist/bin/$command.js" commands info --json >"$scratch/info.json"
node -e 'const info = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
require("fs").writeFileSync(process.argv[2], JSON.stringify(info.schemas))
require("fs").writeFileSync(process.argv[3], JSON.stringify(info.reasons))' \
  "$scratch/info.json" "$scratch/schemas.json" "$scratch/reasons.json"
# --complete reads each CLI's contract references, so a CLI on an older cli-core does not fail this build for a
# shared command it has not caught up with. It also takes mail's `search messages`, another command than the
# messengers', as inherited until cli-base's mail-shared group (cli-base#436), which leaves `search` out, is in the
# cli-base mail pins. --complete also reports gaps in the other CLIs' published evidence; those are theirs to fix and
# do not fail this build.
status=0
"$root/node_modules/.bin/cli-dev" audit --cli "$root/dist/bin/$command.js" "${others[@]}" --for "$command" \
  --lint "$command=$root/lint" --differences "$root/lint/audit-differences.json" --schemas "$command=$scratch/schemas.json" --reasons "$command=$scratch/reasons.json" \
  >"$scratch/scorecard.txt" 2>"$scratch/problems.txt" || status=$?
theirs="^($(IFS='|'; echo "${names[*]}")): complete audit "
if [ "$status" -ne 0 ] && { ! grep -q " 0 new that block" "$scratch/problems.txt" ||
  grep -Ev "$theirs|^audit: [0-9]+ CLIs, [0-9]+ findings, 0 new that block|^review the rule " "$scratch/problems.txt" | grep -q .; }; then
  cat "$scratch/scorecard.txt" "$scratch/problems.txt"
  exit 1
fi
grep -E "$theirs" "$scratch/problems.txt" >&2 || true
awk -v cli="$command" 'NR == 1 || $1 == cli' "$scratch/scorecard.txt"
grep -q "^$command  *total " "$scratch/scorecard.txt" || { echo "audit: no scorecard row for $command" >&2; exit 1; }
