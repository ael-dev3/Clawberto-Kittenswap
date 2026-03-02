#!/usr/bin/env bash
set -euo pipefail

OWNER_REF="${1:-0xc979efda857823bca9a335a6c7b62a7531e1cfea}"
RECIPIENT_REF="${2:-$OWNER_REF}"
EDGE_BPS="${3:-850}"
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
cron_check="$(CRON_JSON="$cron_json" EXPECTED_CRON_EVERY_MS="$EXPECTED_CRON_EVERY_MS" OWNER_REF="$OWNER_REF" EDGE_BPS="$EDGE_BPS" HYPEREVM_ENV_SCRIPT="$HYPEREVM_ENV_SCRIPT" python3 - <<'PY'
import json, os, re, sys
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
edge_bps = str(os.environ.get('EDGE_BPS') or '850').strip()
msg_norm = ' '.join(msg.split())
edge_re = re.compile(r'--edge-bps\s+' + re.escape(edge_bps) + r'(?:\b|\s|$)', re.IGNORECASE)
if not edge_re.search(msg_norm):
    ok = False
    issues.append(f'missing_edge_bps_{edge_bps}')
if '--contract' not in msg:
    ok = False
    issues.append('missing_contract_mode_flag')
if 'Reply with EXACT stdout only' not in msg:
    ok = False
    issues.append('missing_exact_stdout_directive')
if env_script and env_script not in msg:
    ok = False
    issues.append('missing_env_source_script')
if owner_ref and owner_ref not in msg.lower():
    ok = False
    issues.append('missing_owner_ref_in_payload')
if ok:
    print('OK:' + str(job.get('id') or '') + ':' + str(job.get('updatedAtMs') or 0))
else:
    print('ERR:' + ','.join(issues))
PY
)"
heartbeat_job_id=""
heartbeat_job_updated_ms="0"
if [[ "$cron_check" == OK:* ]]; then
  IFS=':' read -r _ok_tag heartbeat_job_id heartbeat_job_updated_ms <<< "$cron_check"
  pass "heartbeat cron job exists, enabled, and runs every ${EXPECTED_CRON_EVERY_MS}ms"
else
  fail "heartbeat cron contract issue: $cron_check"
fi

if [[ -n "$heartbeat_job_id" ]]; then
  execution_claim_check="$(HEARTBEAT_JOB_ID="$heartbeat_job_id" HEARTBEAT_JOB_UPDATED_MS="$heartbeat_job_updated_ms" python3 - <<'PY'
import json, os, re, sys
from pathlib import Path
jid = os.environ.get('HEARTBEAT_JOB_ID', '').strip()
updated_ms = int(os.environ.get('HEARTBEAT_JOB_UPDATED_MS') or 0)
if not jid:
    print('ERR:no_job_id')
    sys.exit(0)
runs = Path(f'/Users/marko/.openclaw/cron/runs/{jid}.jsonl')
if not runs.exists():
    print('ERR:missing_runs_file')
    sys.exit(0)
entries=[]
for line in runs.read_text().splitlines():
    line=line.strip()
    if not line:
      continue
    try:
      obj=json.loads(line)
    except Exception:
      continue
    run_ms = int(obj.get('runAtMs') or obj.get('ts') or 0)
    if run_ms < updated_ms:
      continue
    entries.append(obj)
# inspect recent post-update runs for false execution claims
suspicious=[]
for obj in entries[-6:]:
    s=(obj.get('summary') or '')
    sl=s.lower()
    if 'required heartbeat action' not in sl:
      continue
    if 'rebalance_compound_restake' not in sl:
      continue
    if 'executed' not in sl:
      continue
    txs=set(re.findall(r'0x[a-fA-F0-9]{64}', s))
    if len(txs) < 6:
      suspicious.append({'sessionId':obj.get('sessionId'), 'tx_count':len(txs)})
if suspicious:
    print('ERR:execution_claim_without_hashes:' + ';'.join(f"{x['sessionId']}#{x['tx_count']}" for x in suspicious))
else:
    print('OK')
PY
)"
  if [[ "$execution_claim_check" == "OK" ]]; then
    pass "execution claims in recent heartbeat runs include tx-hash evidence"
  else
    fail "execution-claim integrity issue: $execution_claim_check"
  fi

  latest_run_check="$(HEARTBEAT_JOB_ID="$heartbeat_job_id" EXPECTED_CRON_EVERY_MS="$EXPECTED_CRON_EVERY_MS" python3 - <<'PY'
import json, os, re, sys, time
from pathlib import Path
jid = os.environ.get('HEARTBEAT_JOB_ID', '').strip()
expected_every_ms = int(os.environ.get('EXPECTED_CRON_EVERY_MS') or 3600000)
if not jid:
    print('ERR:no_job_id')
    sys.exit(0)
runs = Path(f'/Users/marko/.openclaw/cron/runs/{jid}.jsonl')
if not runs.exists():
    print('ERR:missing_runs_file')
    sys.exit(0)
entries=[]
for line in runs.read_text().splitlines():
    line=line.strip()
    if not line:
        continue
    try:
        obj=json.loads(line)
    except Exception:
        continue
    run_ms = int(obj.get('runAtMs') or obj.get('ts') or 0)
    if run_ms <= 0:
        continue
    entries.append((run_ms, obj))
if not entries:
    print('ERR:no_runs')
    sys.exit(0)
run_ms, latest = max(entries, key=lambda t: t[0])
now_ms = int(time.time() * 1000)
if now_ms - run_ms > expected_every_ms + 900000:
    print(f'ERR:latest_run_stale:{now_ms-run_ms}ms')
    sys.exit(0)
summary = (latest.get('summary') or '')
sl = summary.lower()
required_labels = [
    'decision:',
    'rebalance evaluation:',
    'required heartbeat action:',
    'range each side:',
    'ticks each side now:',
    'configured ticks each side:',
    'min headroom:',
    'pending reward delta:',
    'est apr:',
]
missing = [x for x in required_labels if x not in sl]
if missing:
    print('ERR:latest_missing_fields:' + ','.join(missing))
    sys.exit(0)

decision_reb = 'decision: rebalance_compound_restake' in sl
action_reb = 'required heartbeat action: rebalance_compound_restake' in sl
if decision_reb or action_reb:
    if 'executed' in sl:
        tx_count = len(set(re.findall(r'0x[a-fA-F0-9]{64}', summary)))
        if tx_count < 6:
            print(f'ERR:latest_executed_without_hashes:{tx_count}')
            sys.exit(0)
        if not ('post-action' in sl or 'new tokenid' in sl or 'post-action verification heartbeat' in sl):
            print('ERR:latest_executed_missing_post_action_context')
            sys.exit(0)
    elif 'blocked' in sl:
        pass
    else:
        print('ERR:latest_trigger_missing_executed_or_blocked')
        sys.exit(0)
print('OK:' + str(latest.get('sessionId') or ''))
PY
)"
  if [[ "$latest_run_check" == OK:* ]]; then
    pass "latest heartbeat run summary is fresh and contract-complete"
  else
    fail "latest-run contract issue: $latest_run_check"
  fi
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
    "- est apr:"
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

contract_out="$(node "$HEARTBEAT_HELPER" "$OWNER_REF" --recipient "$RECIPIENT_REF" --edge-bps "$EDGE_BPS" --contract 2>/tmp/krlp_guardrail_contract.err || true)"
if [[ -z "$contract_out" ]]; then
  fail "heartbeat contract-output command failed: $(tail -n 2 /tmp/krlp_guardrail_contract.err 2>/dev/null || echo unknown)"
else
  contract_required=(
    "decision:"
    "rebalance evaluation:"
    "required heartbeat action:"
    "range each side:"
    "ticks each side now:"
    "configured ticks each side:"
    "min headroom:"
    "pending reward delta:"
    "est apr:"
    "post-action tokenId/status:"
  )
  for needle in "${contract_required[@]}"; do
    if grep -Fq -- "$needle" <<<"$contract_out"; then
      pass "contract output contains '$needle'"
    else
      fail "contract output missing '$needle'"
    fi
  done
fi

echo "Audit result: pass=$pass_count fail=$fail_count"
if [[ "$fail_count" -gt 0 ]]; then
  exit 1
fi
