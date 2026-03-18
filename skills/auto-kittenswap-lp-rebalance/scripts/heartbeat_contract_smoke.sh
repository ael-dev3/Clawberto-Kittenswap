#!/usr/bin/env bash
set -euo pipefail

OWNER_REF="${1:-}"
RECIPIENT_REF="${2:-}"

OWNER_LABEL="${OWNER_REF:-<default-account>}"
RECIPIENT_LABEL="${RECIPIENT_REF:-<auto-resolved>}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="$SCRIPT_DIR/heartbeat_active_token.mjs"
DEFAULT_EDGE_BPS="$(node "$SCRIPT_DIR/krlp_print_defaults.mjs" heartbeat.edgeBps 2>/dev/null || echo 850)"
EDGE_BPS="${3:-$DEFAULT_EDGE_BPS}"

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

run_helper_with_retry() {
  local __out_var="$1"
  shift
  local attempt=1
  local max_attempts=4
  local sleep_s=1
  local out err_file err

  while [ "$attempt" -le "$max_attempts" ]; do
    err_file="$(mktemp /tmp/krlp_hb_smoke_err.XXXXXX)"
    if out="$("$@" 2>"$err_file")"; then
      rm -f "$err_file"
      printf -v "$__out_var" '%s' "$out"
      return 0
    fi

    err="$(cat "$err_file" 2>/dev/null || true)"
    rm -f "$err_file"

    if grep -Eiq 'rate[[:space:]]*limit|rate[[:space:]]*limited|\b429\b' <<<"$err" && [ "$attempt" -lt "$max_attempts" ]; then
      sleep "$sleep_s"
      sleep_s=$((sleep_s * 2))
      attempt=$((attempt + 1))
      continue
    fi

    echo "$err" >&2
    return 1
  done

  return 1
}

echo "[1/3] summary output contract"
run_helper_with_retry SUMMARY_OUT "${BASE_CMD[@]}"
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

echo "[2/3] raw output contract"
RAW_CMD=("${BASE_CMD[@]}" --raw)
run_helper_with_retry RAW_OUT "${RAW_CMD[@]}"

if grep -Fq -- "No active token IDs found for owner" <<<"$RAW_OUT"; then
  echo "[PASS] raw output reports no active LP position"
else
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
fi

echo "[3/3] strict contract output"
CONTRACT_CMD=("${BASE_CMD[@]}" --contract)
run_helper_with_retry CONTRACT_OUT "${CONTRACT_CMD[@]}"

require_line "$CONTRACT_OUT" "decision:"
require_line "$CONTRACT_OUT" "rebalance evaluation:"
require_line "$CONTRACT_OUT" "required heartbeat action:"
require_line "$CONTRACT_OUT" "range each side:"
require_line "$CONTRACT_OUT" "ticks each side now:"
require_line "$CONTRACT_OUT" "configured ticks each side:"
require_line "$CONTRACT_OUT" "min headroom:"
require_line "$CONTRACT_OUT" "pending reward delta:"
require_line "$CONTRACT_OUT" "est apr:"
require_line "$CONTRACT_OUT" "post-action tokenId/status:"

echo "[4/4] highlight output contract"
HIGHLIGHT_CMD=("${BASE_CMD[@]}" --highlight)
run_helper_with_retry HIGHLIGHT_OUT "${HIGHLIGHT_CMD[@]}"

require_line "$HIGHLIGHT_OUT" "Heartbeat update"
require_line "$HIGHLIGHT_OUT" "Key status:"
require_line "$HIGHLIGHT_OUT" "• Range each side:"
require_line "$HIGHLIGHT_OUT" "• Ticks each side now:"
require_line "$HIGHLIGHT_OUT" "• Configured ticks each side:"
require_line "$HIGHLIGHT_OUT" "• Pending reward now:"
require_line "$HIGHLIGHT_OUT" "• Pending reward delta:"
require_line "$HIGHLIGHT_OUT" "• Est APR:"
require_line "$HIGHLIGHT_OUT" "Outcome:"

echo "[PASS] heartbeat contract smoke checks passed"
