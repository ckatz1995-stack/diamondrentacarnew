#!/usr/bin/env bash
set -euo pipefail

echo "[smoke] Checking frontend page syntax..."
while IFS= read -r -d '' file; do
  node --check "$file"
done < <(find src/pages -maxdepth 1 -type f -name '*.js' -print0)

echo "[smoke] Running lint..."
npm run lint

echo "[smoke] Running unfinished markers check..."
npm run check:undone

echo "[smoke] Done."
