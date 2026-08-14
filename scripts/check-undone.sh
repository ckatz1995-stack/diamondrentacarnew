#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Uses grep rather than rg: ripgrep is not installed on CI runners, and the
# `|| echo "None found"` below would otherwise swallow its command-not-found
# exit and report a clean scan on every run.
echo "== Potential unfinished markers (TODO/FIXME/TBD/HACK/XXX) =="
grep -rnE "TODO|FIXME|TBD|HACK|XXX" src \
  --include='*.js' --include='*.jsw' --include='*.md' || echo "None found"

echo
echo "== Temporary files that may indicate unfinished work =="
find src -type f -name '*.tmp.*' | grep . || echo "None found"
