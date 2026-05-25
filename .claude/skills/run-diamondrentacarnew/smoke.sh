#!/usr/bin/env bash
# Diamond Rent A Car — booking-UI smoke driver
# Serves all 6 HTML pages locally and validates each one for structural integrity.
# Uses temp files for curl output — large pages (index.html ~472KB) exceed
# bash's echo/variable limit, so piping via a temp file is the only reliable path.
#
# Usage (run from repo root):
#   bash .claude/skills/run-diamondrentacarnew/smoke.sh
#   bash .claude/skills/run-diamondrentacarnew/smoke.sh --verbose
#
# Exit 0 = all pages healthy.  Exit 1 = one or more checks failed.

set -uo pipefail  # no -e: arithmetic ((FAIL++)) exits 1 under -e when FAIL=0
VERBOSE=${1:-}
PORT=7789
UI_DIR="src/public/booking-ui"
PAGES=(index.html checkout.html options.html vehicles.html terms.html success.html)
TMP=$(mktemp)

PASS=0; FAIL=0

# Serve in background; trap ensures cleanup
python3 -m http.server "$PORT" --directory "$UI_DIR" &>/dev/null &
SERVER_PID=$!
trap "kill $SERVER_PID 2>/dev/null; wait $SERVER_PID 2>/dev/null; rm -f $TMP" EXIT
sleep 1.5   # wait for server; <0.6s is too short for large files

check() {
  local label=$1 pattern=$2
  if grep -q "$pattern" "$TMP"; then
    [[ -n $VERBOSE ]] && echo "  PASS  $label"
    ((PASS++)) || true
  else
    echo "  FAIL  $label  (pattern: $pattern)"
    ((FAIL++)) || true
  fi
}

for page in "${PAGES[@]}"; do
  echo "── $page"
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT/$page")
  if [[ $STATUS != "200" ]]; then
    echo "  FAIL  HTTP $STATUS"
    ((FAIL++)) || true
    continue
  fi
  # Fetch to temp file (large pages like index.html ~472KB exceed bash echo limit)
  curl -s "http://localhost:$PORT/$page" > "$TMP"
  check "amber body"   "c8a438"
  check "header"       "site-header"
  check "footer"       "footer"
  check "style closed" "</style>"
  case $page in
    index.html)
      check "stats bar"  "stats-bar"
      check "fleet grid" "fleet-grid"
      check "reviews"    "reviews-grid"
      check "cta strip"  "cta-strip"
      ;;
    checkout.html) check "submit btn"   "btn-submit" ;;
    options.html)  check "mobile patch" "mobile-flow-patch" ;;
    vehicles.html) check "search wrap"  "search-wrap" ;;
    terms.html)    check "terms main"   "termsMain" ;;
    success.html)  check "booking no"   "sideBookingNo" ;;
  esac
done

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
