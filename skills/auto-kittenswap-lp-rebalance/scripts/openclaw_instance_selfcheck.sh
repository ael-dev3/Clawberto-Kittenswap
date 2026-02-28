#!/usr/bin/env bash
set -euo pipefail

OWNER_REF="${1:-farcaster}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHAT_SCRIPT="$SCRIPT_DIR/kittenswap_rebalance_chat.mjs"
HEARTBEAT_HELPER="$SCRIPT_DIR/heartbeat_active_token.mjs"
RPC_URL="https://rpc.hyperliquid.xyz/evm"
EXPECTED_CHAIN_ID="999"

PASS_COUNT=0
FAIL_COUNT=0

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf "[PASS] %s\n" "$1"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  printf "[FAIL] %s\n" "$1"
}

check_cmd() {
  local cmd="$1"
  if command -v "$cmd" >/dev/null 2>&1; then
    pass "binary available: $cmd"
  else
    fail "missing binary: $cmd"
  fi
}

echo "OpenClaw instance self-check (owner=${OWNER_REF})"
echo "- scripts dir: $SCRIPT_DIR"

echo "\n[1] Runtime prerequisites"
check_cmd node
check_cmd cast

if [ -f "$CHAT_SCRIPT" ]; then
  pass "chat entrypoint exists: $CHAT_SCRIPT"
else
  fail "missing chat entrypoint: $CHAT_SCRIPT"
fi

if [ -f "$HEARTBEAT_HELPER" ]; then
  pass "heartbeat helper exists: $HEARTBEAT_HELPER"
else
  fail "missing heartbeat helper: $HEARTBEAT_HELPER"
fi

echo "\n[2] Chain connectivity"
if command -v cast >/dev/null 2>&1; then
  CHAIN_ID="$(cast chain-id --rpc-url "$RPC_URL" 2>/dev/null || true)"
  if [ "$CHAIN_ID" = "$EXPECTED_CHAIN_ID" ]; then
    pass "RPC reachable and chain id is $EXPECTED_CHAIN_ID"
  else
    fail "RPC/chain mismatch (got '${CHAIN_ID:-empty}', expected $EXPECTED_CHAIN_ID)"
  fi
fi

echo "\n[3] Signer context"
if [ -n "${HYPEREVM_EXEC_PRIVATE_KEY:-}" ]; then
  ADDR="$(cast wallet address --private-key "$HYPEREVM_EXEC_PRIVATE_KEY" 2>/dev/null || true)"
  if [ -n "$ADDR" ]; then
    pass "HYPEREVM_EXEC_PRIVATE_KEY loaded (derived address: $ADDR)"
  else
    fail "HYPEREVM_EXEC_PRIVATE_KEY is set but address derivation failed"
  fi
else
  fail "HYPEREVM_EXEC_PRIVATE_KEY not set in environment"
fi

echo "\n[4] Skill-level checks"
if node "$CHAT_SCRIPT" "krlp health" >/tmp/krlp_health.out 2>/tmp/krlp_health.err; then
  pass "krlp health"
else
  fail "krlp health failed ($(tail -n 1 /tmp/krlp_health.err 2>/dev/null || echo no-stderr))"
fi

if node "$CHAT_SCRIPT" "krlp account list" >/tmp/krlp_account_list.out 2>/tmp/krlp_account_list.err; then
  pass "krlp account list"
else
  fail "krlp account list failed ($(tail -n 1 /tmp/krlp_account_list.err 2>/dev/null || echo no-stderr))"
fi

echo "\n[5] Heartbeat dry-run smoke test"
if node "$HEARTBEAT_HELPER" "$OWNER_REF" --recipient "$OWNER_REF" --edge-bps 500 --autonomous --no-next-steps >/tmp/krlp_heartbeat_smoke.out 2>/tmp/krlp_heartbeat_smoke.err; then
  pass "heartbeat_active_token.mjs dry-run"
else
  fail "heartbeat_active_token.mjs failed ($(tail -n 1 /tmp/krlp_heartbeat_smoke.err 2>/dev/null || echo no-stderr))"
fi

echo "\nSummary: pass=$PASS_COUNT fail=$FAIL_COUNT"
if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
