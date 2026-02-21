# Rebalance Playbook

## Goal

Keep concentrated liquidity near the current market tick while controlling execution risk.

## Deterministic flow

1. Run health check:
- `krlp health`

2. Inspect position:
- `krlp position <tokenId> [owner|label]`

3. Evaluate rebalance need:
- `krlp status <tokenId> [--edge-bps N]`

4. Build execution-safe plan (dry-run):
- `krlp plan <tokenId> [owner|label] --recipient <address|label> [--amount0 X --amount1 Y]`
- Burn is excluded by default. Include only when intentional:
- `krlp plan <tokenId> ... --allow-burn`

5. Sign transactions outside skill (wallet/custody).

6. Optional raw broadcast:
- `krlp broadcast-raw <0xSignedTx> --yes SEND`

## Safety rules

- Never execute using truncated addresses.
- Verify `from` account can operate NFT (owner or approved operator).
- Prefer test-size mint amounts first when onboarding new wallet flow.
- Use strict slippage thresholds when filling mint amounts.
- Abort if chain id does not match `999`.

## Common failure modes

- `owner != from`: sender lacks permission for position NFT operations.
- `amount0/amount1 omitted`: mint call data intentionally not generated.
- `mint` still reverts: confirm approvals target `NonfungiblePositionManager`, not router.
- `mint` still reverts: verify ticks are multiples of pool `tickSpacing`.
- `mint` reverts at ~25k gas: verify signer/balance/allowance at tx block with `krlp mint-verify <txHash> <expectedOwner|label>`.
- `mint` reverts without reason: check if tx block tick was outside selected range with non-zero mins on both tokens.
- `eth_estimateGas` unavailable: calldata may still be valid, but simulation failed due permissions/balances/allowances.

## First-time LP mint flow (no existing NFT)

1. Build mint plan:
- `krlp mint-plan <tokenA> <tokenB> --amount-a X --amount-b Y [owner|label] [--recipient <address|label>]`

2. Optional explicit range:
- `--tick-lower N --tick-upper N`
- or auto-centered range: `--width-ticks N [--center-tick N]`

3. Check preflight in output:
- token-order normalization to token0/token1
- pool tick spacing + selected range alignment
- nearest range-edge distance warning (avoid signing when headroom is too tight)
- wallet balances and position-manager allowances
- direct `eth_call` mint simulation result

4. Sign approvals first (if required), then sign mint, then broadcast.
5. Verify each submitted tx:
- `krlp tx-verify <txHash>`
- `krlp mint-verify <mintTxHash> <expectedOwner|label>` for signer/race/out-of-range forensics
- for approvals, ensure decoded approve `amount` is non-zero and current allowance increased

## Farming / staking flow (earn KITTEN)

1. Inspect current farming state:
- `krlp farm-status <tokenId> [owner|label]`

2. Approve farming center at position manager:
- `krlp farm-approve-plan <tokenId> [owner|label]`

3. Enter active incentive (auto key from pool):
- `krlp farm-enter-plan <tokenId> [owner|label] --auto-key`

4. Periodically accrue + claim rewards:
- `krlp farm-collect-plan <tokenId> [owner|label] --auto-key`
- `krlp farm-claim-plan <rewardToken> [owner|label] --amount max`

5. Exit farming when needed:
- `krlp farm-exit-plan <tokenId> [owner|label] --auto-key`

## Swap flow (Kittenswap-only)

1. Quote:
- `krlp swap-quote <tokenIn> <tokenOut> --deployer <address> --amount-in <decimal>`

2. Build approval transaction (if allowance is low):
- `krlp swap-approve-plan <tokenIn> [owner|label] --amount <decimal|max>`

3. Build swap calldata plan:
- `krlp swap-plan <tokenIn> <tokenOut> --deployer <address> --amount-in <decimal> [owner|label] [--native-in]`

4. Sign transactions outside the skill.

5. Broadcast signed payload:
- `krlp broadcast-raw <0xSignedTx> --yes SEND`

Execution guardrails:
- Only send when swap-plan reports `direct swap eth_call simulation: PASS`.
- If swap-plan reports `UNAVAILABLE (RPC timeout/rate-limit)`, rerun until `PASS`.
- Do not send plans with any `BLOCKER:` line.
- Sign/send immediately; stale deadlines fail with `Transaction too old`.
- For failed swaps, run `krlp swap-verify <txHash>` and inspect `deadline vs tx block`.

### Block-safe dependency protocol (approve -> swap)

Do not parallelize approve and swap submissions.

1. Submit approve tx only.
2. Wait until approve receipt is `success`.
3. Wait at least 1 additional confirmation block.
4. Run `krlp tx-verify <approveTxHash>` and confirm allowance is non-zero and sufficient.
5. Re-run `krlp swap-plan ...` and require preflight allowance/simulation `PASS`.
6. Submit swap tx.

If swap fails with zero logs, run `krlp swap-verify <txHash>`. The verifier now checks pre-tx allowance/balance at block `N-1` to detect race conditions (approval mined too late or funding arrived too late).

Safety:
- Keep slippage conservative (`--slippage-bps`).
- Confirm pool/deployer before signing.
- LP mint approvals must target position manager, not router.
- Farming enter requires `approveForFarming` at position manager before `enterFarming`.
- Never reconstruct truncated addresses.
