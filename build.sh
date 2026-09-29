#!/usr/bin/env bash
# Package exactly as the confirmed-working empty Zotero test plugin.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p dist
OUT="dist/citeloom-0.1.32.xpi"
rm -f "$OUT"
zip -X -q "$OUT" manifest.json bootstrap.js citation-graph.js citation-view.js style.css icon.svg prefs.js preferences.xhtml
unzip -t "$OUT"
unzip -Z1 "$OUT"
printf '\nBuilt: %s\n' "$OUT"
