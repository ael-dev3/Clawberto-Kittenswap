# HEARTBEAT Runbook

Deterministic heartbeat workflow for automatic LP rebalance and reward compounding on Kittenswap.

## Goal

On each heartbeat tick, decide exactly one branch:
- `HOLD` (no churn), or
- `REBALANCE_COMPOUND_RESTAKE` (full lifecycle).

## Canonical command

```bash
krlp heartbeat <tokenId> <ownerOrLabel> --recipient <ownerOrLabel>
```

Optional overrides:
- `--edge-bps N` (default `500`, meaning 5%)
- `--width-bump-ticks N` (default `100`)
- `--policy <name>`
- `--slippage-bps N`
- `--deadline-seconds N`
- `--farming-center <address>`
- `--eternal-farming <address>`

## Trigger policy (anti-churn)

Heartbeat rebalances only when:
- position is out of range, or
- position is within 5% of an edge (`edge-bps=500`).

If neither is true, heartbeat returns `HOLD`.

## Range-width policy (slow widening)

When heartbeat triggers rebalance:
- target replacement width = current width + `100` ticks (aligned to pool tick spacing).
- this makes automatic mode widen gradually to reduce churn/volatility impact.
- humans can manually tighten later; heartbeat then widens from that new width.

## Reward policy

- Primary reward is always claimed/compounded when rebalancing.
- Bonus reward token is claimed only when bonus emission is active.
- If bonus token exists but emission rate is `0`, treat it as KITTEN-only reward mode.

## Strict execution rules

1. Never hand-encode calldata.
2. Use only `krlp *-plan` generated calldata.
3. Stop immediately on any `BLOCKER` or simulation `REVERT`.
4. Execute dependent txs sequentially; never parallelize approval/swap/mint/farm chains.
5. Run `krlp tx-verify <txHash>` after each broadcast before moving to next step.
6. Do not burn NFT unless explicit `--allow-burn` was requested.

## Branch behavior

### HOLD

- Do not unwind LP.
- Optional harvest only:
  - `krlp farm-collect-plan <tokenId> <owner> --auto-key`
  - `krlp farm-claim-plan <rewardToken> <owner> --amount max`
  - claim bonus only if heartbeat/farm-status shows non-zero bonus emission.

### REBALANCE_COMPOUND_RESTAKE

1. Preflight:
   - `krlp status <tokenId> --edge-bps 500`
   - `krlp farm-status <tokenId> <owner>`
2. If staked:
   - `krlp farm-exit-plan <tokenId> <owner> --auto-key`
   - claim rewards (primary, and bonus only if active)
3. Generate rebalance plan:
   - `krlp plan <tokenId> <owner> --recipient <owner> --edge-bps 500 --width-bump-ticks 100`
4. Execute plan tx templates in exact order.
5. Restake newly minted NFT:
   - `krlp farm-status <newTokenId> <owner>`
   - `krlp farm-approve-plan <newTokenId> <owner>`
   - `krlp farm-enter-plan <newTokenId> <owner> --auto-key`

## Expected heartbeat output contract

`krlp heartbeat` must always print:
- current tick/range and side percentages,
- 5% threshold evaluation,
- final decision (`HOLD` or `REBALANCE_COMPOUND_RESTAKE`),
- reward mode (`SINGLE_REWARD` / `DUAL_REWARD`),
- exact command sequence for the chosen branch.
