#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "== Potential unfinished markers (TODO/FIXME/TBD/HACK/XXX) =="
rg -n "TODO|FIXME|TBD|HACK|XXX" src --glob '*.js' --glob '*.jsw' --glob '*.md' || echo "None found"

echo
echo "== Temporary files that may indicate unfinished work =="
rg --files src | rg '\.tmp\.' || echo "None found"
