#!/usr/bin/env bash
set -euo pipefail

OWNER_REF="${1:-}"
RECIPIENT_REF="${2:-}"
EDGE_BPS="${3:-850}"

OWNER_LABEL="${OWNER_REF:-<default-account>}"
RECIPIENT_LABEL="${RECIPIENT_REF:-<auto-resolved>}"

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

echo "[heartbeat-smoke] owner=$OWNER_LABEL recipient=$RECIPIENT_LABEL edge_bps=$EDGE_BPS"

BASE_CMD=(node "$HELPER")
if [ -n "$OWNER_REF" ]; then BASE_CMD+=("$OWNER_REF"); fi
if [ -n "$RECIPIENT_REF" ]; then BASE_CMD+=(--recipient "$RECIPIENT_REF"); fi
BASE_CMD+=(--edge-bps "$EDGE_BPS")

echo "[1/2] summary output contract"
SUMMARY_OUT="$("${BASE_CMD[@]}")"
echo "$SUMMARY_OUT"

require_line "$SUMMARY_OUT" "Kittenswap heartbeat summary"
require_line "$SUMMARY_OUT" "- decision:"
require_line "$SUMMARY_OUT" "- range:"
require_line "$SUMMARY_OUT" "- range each side:"
require_line "$SUMMARY_OUT" "- ticks each side now:"
require_line "$SUMMARY_OUT" "- configured ticks each side:"
require_line "$SUMMARY_OUT" "- tick side status:"
require_line "$SUMMARY_OUT" "- min headroom:"
require_line "$SUMMARY_OUT" "- stake:"
require_line "$SUMMARY_OUT" "- pending reward delta:"
require_line "$SUMMARY_OUT" "- est apr:"
require_line "$SUMMARY_OUT" "- mode/branch:"

echo "[2/2] raw output contract"
RAW_CMD=("${BASE_CMD[@]}" --raw)
RAW_OUT="$("${RAW_CMD[@]}")"

require_line "$RAW_OUT" "Kittenswap heartbeat plan"
require_line "$RAW_OUT" "- decision:"
require_line "$RAW_OUT" "- required heartbeat action:"
require_line "$RAW_OUT" "- stake integrity:"
require_line "$RAW_OUT" "- within range:"
require_line "$RAW_OUT" "- range each side:"
require_line "$RAW_OUT" "- range ticks each side now:"
require_line "$RAW_OUT" "- configured ticks each side (half-width):"
require_line "$RAW_OUT" "- pending reward delta since last heartbeat:"
require_line "$RAW_OUT" "- est apr (realized from pending delta):"

echo "[PASS] heartbeat contract smoke checks passed"
