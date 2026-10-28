#!/usr/bin/env bash
# `cli-dev audit` needs the other CLIs' command trees: this audits the built CLI beside the latest published ones of
# cli-base's "all" parity group, and fails only on a new finding that names this CLI.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
command=$(node --input-type=module -e "import('$root/dist/identity.js').then((m) => console.log(m.IDENTITY.command))")
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
# A CLI that starts may move the store under HOME; every CLI run here gets a throwaway one.
export HOME="$scratch/home" MESSAGING_STORE="$scratch/store" WIRECAT_STATE_DIR="$scratch/state"
mkdir -p "$HOME"
npm install -g --prefix "$scratch/prefix" --ignore-scripts --no-audit --no-fund --loglevel error \
  @wirecat/tg-cli @wirecat/max-cli @wirecat/whatsapp-cli @wirecat/cli-memo @wirecat/drive-cli @wirecat/zoom-cli
bin="$scratch/prefix/bin"
others=()
# A groups file replaces cli-base's PARITY_GROUPS. The template keeps one because it is in no group of cli-base's.
[ -f "$root/config/parity-groups.json" ] && others+=(--groups "$root/config/parity-groups.json")
for cli in tg max wa memo drive zm; do
  [ "$cli" = "$command" ] || others+=(--cli "$bin/$cli")
done
"$root/node_modules/.bin/cli-dev" audit --cli "$root/dist/bin/$command.js" "${others[@]}" --for "$command" \
  --lint "$command=$root/lint" >"$scratch/scorecard.txt" || { cat "$scratch/scorecard.txt"; exit 1; }
awk -v cli="$command" 'NR == 1 || $1 == cli' "$scratch/scorecard.txt"
grep -q "^$command  *total " "$scratch/scorecard.txt" || { echo "audit: no scorecard row for $command" >&2; exit 1; }
