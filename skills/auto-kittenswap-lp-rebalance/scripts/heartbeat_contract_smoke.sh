#!/usr/bin/env bash
set -euo pipefail

OWNER_REF="${1:-farcaster}"
RECIPIENT_REF="${2:-$OWNER_REF}"
EDGE_BPS="${3:-500}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="$SCRIPT_DIR/heartbeat_active_token.mjs"

require_line() {
  local haystack="$1"
  local needle="$2"
  if ! grep -Fq -- "$needle" <<<"$haystack"; then
    echo "[FAIL] missing expected line: $needle" >&2
    return 1
  fi
}

echo "[heartbeat-smoke] owner=$OWNER_REF recipient=$RECIPIENT_REF edge_bps=$EDGE_BPS"

echo "[1/2] summary output contract"
SUMMARY_OUT="$(node "$HELPER" "$OWNER_REF" --recipient "$RECIPIENT_REF" --edge-bps "$EDGE_BPS")"
echo "$SUMMARY_OUT"

require_line "$SUMMARY_OUT" "Kittenswap heartbeat summary"
require_line "$SUMMARY_OUT" "- decision:"
require_line "$SUMMARY_OUT" "- rebalance evaluation:"
require_line "$SUMMARY_OUT" "- required heartbeat action:"
require_line "$SUMMARY_OUT" "- within range:"
require_line "$SUMMARY_OUT" "- range each side:"
require_line "$SUMMARY_OUT" "- min headroom pct:"
require_line "$SUMMARY_OUT" "- staked in configured Kittenswap farm:"
require_line "$SUMMARY_OUT" "- stake integrity:"
require_line "$SUMMARY_OUT" "- branch:"

echo "[2/2] raw output contract"
RAW_OUT="$(node "$HELPER" "$OWNER_REF" --recipient "$RECIPIENT_REF" --edge-bps "$EDGE_BPS" --raw)"

require_line "$RAW_OUT" "Kittenswap heartbeat plan"
require_line "$RAW_OUT" "- decision:"
require_line "$RAW_OUT" "- required heartbeat action:"
require_line "$RAW_OUT" "- stake integrity:"
require_line "$RAW_OUT" "- within range:"
require_line "$RAW_OUT" "- range each side:"


echo "[PASS] heartbeat contract smoke checks passed"
