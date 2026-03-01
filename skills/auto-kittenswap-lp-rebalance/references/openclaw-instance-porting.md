# OpenClaw Instance Porting Checklist (Local Rebalance Execution)

Use this checklist when migrating the Kittenswap rebalance stack to a new local OpenClaw instance.

## 1) Workspace + repo

1. Clone repo into the target instance workspace.
2. Verify expected paths exist:
   - `skills/auto-kittenswap-lp-rebalance/SKILL.md`
   - `scripts/kittenswap_rebalance_chat.mjs`
   - `scripts/heartbeat_active_token.mjs`
   - `scripts/heartbeat_contract_smoke.sh`

## 2) Runtime prerequisites

Required binaries:
- `node`
- `cast` (Foundry)

Required network:
- HyperEVM RPC reachable: `https://rpc.hyperliquid.xyz/evm`
- Chain ID must be `999`

## 3) Signer setup (secure)

Do **not** store raw private keys in repo files.

Use secure local secret storage and expose signer at runtime as:
- `HYPEREVM_EXEC_PRIVATE_KEY`

Recommended local pattern:
- keep a local env loader (outside repo) and source it in shell profile
- confirm derived signer address before execution

## 4) Skill/account config

1. Add account alias and default:
   - `krlp account add <label> <ownerAddress> --default`
2. Verify policy and account maps:
   - `krlp account list`
   - `krlp policy list`

## 5) Heartbeat wiring

Use active-token helper to avoid stale IDs after rebalance rolls:

```bash
node skills/auto-kittenswap-lp-rebalance/scripts/heartbeat_active_token.mjs <owner|label> --recipient <owner|label> --edge-bps 500 --autonomous --no-next-steps
```

Branch behavior:
- `HOLD` => no on-chain action
- `REBALANCE_COMPOUND_RESTAKE` => execute deterministic chain

## 6) Deterministic execution chain (when triggered)

1. `farm-exit-plan` (if staked)
2. `farm-claim-plan`
3. `withdraw` (collect -> decrease -> collect)
4. inventory rebalance swaps
5. mint replacement LP
6. `farm-approve-plan`
7. `farm-enter-plan`

Hard rules:
- no hand-encoded calldata
- stop on `BLOCKED` or simulation `REVERT`
- sequential sends only
- `krlp tx-verify <txHash>` after each broadcast

## 7) Known live recovery pattern

If mint fails with:
- `revert: Price slippage check`

Then:
1. regenerate fresh mint plan
2. increase slippage guard (`--slippage-bps 500`)
3. resend regenerated calldata only

## 8) One-command readiness check

Run before enabling cron/automation:

```bash
bash skills/auto-kittenswap-lp-rebalance/scripts/openclaw_instance_selfcheck.sh <owner|label>
bash skills/auto-kittenswap-lp-rebalance/scripts/heartbeat_contract_smoke.sh <owner|label> <owner|label> 500
```

Self-check validates binaries, chain connectivity, signer env, core skill health, and heartbeat dry-run.
Heartbeat smoke validates summary/raw heartbeat output contract fields used by cron relays.
