#!/usr/bin/env bash
set -euo pipefail

OWNER_REF="${1:-0xc979efda857823bca9a335a6c7b62a7531e1cfea}"
RECIPIENT_REF="${2:-$OWNER_REF}"
EDGE_BPS="${3:-500}"
EXPECTED_HEARTBEAT_EVERY="${4:-1h}"
EXPECTED_CRON_EVERY_MS="${5:-3600000}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HEARTBEAT_HELPER="$SCRIPT_DIR/heartbeat_active_token.mjs"
SMOKE_SCRIPT="$SCRIPT_DIR/heartbeat_contract_smoke.sh"
HYPEREVM_ENV_SCRIPT="/Users/marko/.openclaw/hyperevm-env.sh"

pass_count=0
fail_count=0

pass() {
  echo "[PASS] $*"
  pass_count=$((pass_count + 1))
}

fail() {
  echo "[FAIL] $*"
  fail_count=$((fail_count + 1))
}

echo "Kittenswap guardrail audit"
echo "- owner: $OWNER_REF"
echo "- recipient: $RECIPIENT_REF"
echo "- edge bps: $EDGE_BPS"

every_cfg="$(openclaw config get agents.defaults.heartbeat.every 2>/dev/null || true)"
if [[ "$every_cfg" == "$EXPECTED_HEARTBEAT_EVERY" ]]; then
  pass "agents.defaults.heartbeat.every = $every_cfg"
else
  fail "agents.defaults.heartbeat.every expected $EXPECTED_HEARTBEAT_EVERY, got '${every_cfg:-<empty>}'"
fi

if [ -f "$HYPEREVM_ENV_SCRIPT" ]; then
  # shellcheck disable=SC1090
  source "$HYPEREVM_ENV_SCRIPT"
  if [[ -n "${HYPEREVM_EXEC_PRIVATE_KEY:-}" ]]; then
    signer_addr="$(cast wallet address "$HYPEREVM_EXEC_PRIVATE_KEY" 2>/dev/null || true)"
    signer_addr_lc="$(printf '%s' "$signer_addr" | tr '[:upper:]' '[:lower:]')"
    owner_ref_lc="$(printf '%s' "$OWNER_REF" | tr '[:upper:]' '[:lower:]')"
    if [[ -z "$signer_addr" ]]; then
      fail "signer key loaded from env script but address derivation failed"
    elif [[ "$signer_addr_lc" == "$owner_ref_lc" ]]; then
      pass "signer key loaded securely and matches owner ($signer_addr)"
    else
      fail "signer key address mismatch (got $signer_addr, expected $OWNER_REF)"
    fi
  else
    fail "signer key missing after sourcing $HYPEREVM_ENV_SCRIPT"
  fi
else
  fail "missing signer env script: $HYPEREVM_ENV_SCRIPT"
fi

cron_json="$(openclaw cron list --json 2>/dev/null || true)"
cron_check="$(CRON_JSON="$cron_json" EXPECTED_CRON_EVERY_MS="$EXPECTED_CRON_EVERY_MS" OWNER_REF="$OWNER_REF" HYPEREVM_ENV_SCRIPT="$HYPEREVM_ENV_SCRIPT" python3 - <<'PY'
import json, os, sys
raw = os.environ.get('CRON_JSON', '').strip()
expected_every = int(os.environ.get('EXPECTED_CRON_EVERY_MS', '3600000'))
if not raw:
    print('ERR:no_cron_json')
    sys.exit(0)
# openclaw may prepend doctor warnings before JSON; extract JSON payload region
start = raw.find('{')
end = raw.rfind('}')
if start == -1 or end == -1 or end <= start:
    print('ERR:cron_json_region_not_found')
    sys.exit(0)
json_payload = raw[start:end+1]
try:
    data = json.loads(json_payload)
except Exception as e:
    print(f'ERR:cron_json_parse:{e}')
    sys.exit(0)
jobs = data.get('jobs') or []
job = None
for j in jobs:
    name = str(j.get('name', ''))
    payload = (j.get('payload') or {}).get('message') or ''
    if 'Kittenswap Heartbeat' in name or 'heartbeat_active_token.mjs' in payload:
        job = j
        break
if not job:
    print('ERR:missing_heartbeat_job')
    sys.exit(0)
schedule = job.get('schedule') or {}
kind = schedule.get('kind')
every_ms = schedule.get('everyMs')
enabled = bool(job.get('enabled'))
msg = ((job.get('payload') or {}).get('message') or '')
owner_ref = (os.environ.get('OWNER_REF') or '').lower()
env_script = os.environ.get('HYPEREVM_ENV_SCRIPT') or ''
ok = True
issues = []
if not enabled:
    ok = False
    issues.append('job_disabled')
if kind != 'every':
    ok = False
    issues.append(f'kind={kind}')
if every_ms != expected_every:
    ok = False
    issues.append(f'everyMs={every_ms}')
if 'heartbeat_active_token.mjs' not in msg:
    ok = False
    issues.append('missing_helper_command')
if '--edge-bps 500' not in msg:
    ok = False
    issues.append('missing_edge_bps_500')
if env_script and env_script not in msg:
    ok = False
    issues.append('missing_env_source_script')
if owner_ref and owner_ref not in msg.lower():
    ok = False
    issues.append('missing_owner_ref_in_payload')
if ok:
    print('OK')
else:
    print('ERR:' + ','.join(issues))
PY
)"
if [[ "$cron_check" == "OK" ]]; then
  pass "heartbeat cron job exists, enabled, and runs every ${EXPECTED_CRON_EVERY_MS}ms"
else
  fail "heartbeat cron contract issue: $cron_check"
fi

if bash "$SMOKE_SCRIPT" "$OWNER_REF" "$RECIPIENT_REF" "$EDGE_BPS" >/tmp/krlp_guardrail_smoke.out 2>/tmp/krlp_guardrail_smoke.err; then
  pass "heartbeat contract smoke"
else
  fail "heartbeat contract smoke failed: $(tail -n 2 /tmp/krlp_guardrail_smoke.err 2>/dev/null || echo unknown)"
fi

summary_out="$(node "$HEARTBEAT_HELPER" "$OWNER_REF" --recipient "$RECIPIENT_REF" --edge-bps "$EDGE_BPS" 2>/tmp/krlp_guardrail_summary.err || true)"
if [[ -z "$summary_out" ]]; then
  fail "heartbeat summary command failed: $(tail -n 2 /tmp/krlp_guardrail_summary.err 2>/dev/null || echo unknown)"
else
  required=(
    "- range each side:"
    "- ticks each side now:"
    "- configured ticks each side:"
    "- tick side status:"
    "- pending reward delta:"
    "- reward mark price:"
    "- lp principal mark:"
    "- est apr (realized sample):"
  )
  for needle in "${required[@]}"; do
    if grep -Fq -- "$needle" <<<"$summary_out"; then
      pass "summary contains '$needle'"
    else
      fail "summary missing '$needle'"
    fi
  done

  if grep -Fq -- "- side pct from lower:" <<<"$summary_out" || grep -Fq -- "- side pct to upper:" <<<"$summary_out"; then
    fail "summary includes redundant side pct legacy lines"
  else
    pass "summary cleaned of redundant side pct legacy lines"
  fi
fi

echo "Audit result: pass=$pass_count fail=$fail_count"
if [[ "$fail_count" -gt 0 ]]; then
  exit 1
fi
