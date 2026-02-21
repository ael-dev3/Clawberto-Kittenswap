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
- `krlp plan <tokenId> [owner|label] --recipient <address|label> [--amount0 X --amount1 Y] [--no-auto-compound]`
- Burn is excluded by default. Include only when intentional:
- `krlp plan <tokenId> ... --allow-burn`

Default rebalance continuation (unless `--no-auto-compound`):
- exit farming + claim rewards when staked
- remove LP principal + fees
- rebalance to 50/50 notional across token0/token1 (include claimed KITTEN rewards; include bonus token only when `farm-status` shows non-zero bonus rate)
- mint replacement position
- immediately stake new NFT (`farm-approve-plan -> farm-enter-plan --auto-key`)

5. Sign transactions outside skill (wallet/custody).

6. Optional raw broadcast:
- `krlp broadcast-raw <0xSignedTx> --yes SEND`

## Safety rules

- Never execute using truncated addresses.
- Verify `from` account can operate NFT (owner or approved operator).
- Prefer test-size mint amounts first when onboarding new wallet flow.
- Use strict slippage thresholds when filling mint amounts.
- Use seconds-based deadlines for plans (avoid accidental millisecond inputs that create ambiguous expiry intent).
- Abort if chain id does not match `999`.

## Common failure modes

- `owner != from`: sender lacks permission for position NFT operations.
- `amount0/amount1 omitted`: mint call data intentionally not generated.
- `mint` still reverts: confirm approvals target `NonfungiblePositionManager`, not router.
- `mint` still reverts: verify ticks are multiples of pool `tickSpacing`.
- `mint` reverts at ~25k gas: verify signer/balance/allowance at tx block with `krlp mint-verify <txHash> <expectedOwner|label>`.
- `mint` reverts at ~25k gas with selector `0xfe3f3be7`: likely malformed/truncated mint calldata; regenerate with `krlp mint-plan` and avoid manual encoding.
- `mint` reverts without reason: check if tx block tick was outside selected range with non-zero mins on both tokens.
- `mint` reverts with `Price slippage check`: desired ratio/min bounds are incompatible with execution price; compare desired-vs-pool ratio in `mint-plan`/`tx-verify`, rebalance toward 50/50 notional, widen range, and/or increase `--slippage-bps`.
- requested width (for example `300 ticks`) ends up as `[-150,150]` near zero: this is usually a bad center assumption. Ticks are signed, and for low-price pools the live tick is often negative. Use `--width-ticks 300` (auto-centers on current tick) or set `--center-tick <currentTick>` explicitly.
- `enterFarming` says `Not approved for farming`: `setApprovalForAll` is not enough; `approveForFarming(tokenId,true,farmingCenter)` must succeed first.
- `enterFarming` says `Not approved for token`: farming center is missing ERC721 transfer approval for that NFT. Fix by calling position manager `setApprovalForAll(farmingCenter,true)` or `approve(tokenId,farmingCenter)` from NFT owner, then retry `enterFarming`.
- `enterFarming` calldata decodes to wrong tokenId/pool/key: treat as malformed/wrong-key submission. Regenerate with `krlp farm-enter-plan <tokenId> <owner> --auto-key`; do not hand-encode.
- `approveForFarming` reverts at ~22k gas: likely malformed selector-only or 2-arg calldata; verify with `krlp tx-verify <txHash>` and regenerate via `krlp farm-approve-plan`.
- `eth_estimateGas` unavailable: calldata may still be valid, but simulation failed due permissions/balances/allowances.

Recovery pattern that worked (confirmed Feb 21, 2026):
- Regenerate range close to current tick (avoid stale/manual drift).
- Keep signer exactly matched to intended owner.
- Re-run mint-plan immediately before signing and submit promptly.
- Result: mint success on `0x92927021036ebb9e9a452d72b70a20a032c4f91e9d9dfe86736023246687c9df`, tokenId `59430`.

## First-time LP mint flow (no existing NFT)

1. Build mint plan:
- `krlp mint-plan <tokenA> <tokenB> --amount-a X --amount-b Y [owner|label] [--recipient <address|label>] [--no-auto-stake]`

2. Optional explicit range:
- `--tick-lower N --tick-upper N`
- or auto-centered range: `--width-ticks N [--center-tick N]`
- default safety gate: out-of-range windows are flagged as `BLOCKER`; use `--allow-out-of-range` only when intentionally placing a one-sided/out-of-range position.

3. Check preflight in output:
- token-order normalization to token0/token1
- pool tick spacing + selected range alignment
- nearest range-edge distance warning (avoid signing when headroom is too tight)
- wallet balances and position-manager allowances
- direct `eth_call` mint simulation result

4. Sign approvals first (if required), then sign mint, then broadcast.
5. Default post-mint policy (no extra prompt): immediately run staking path for new tokenId:
- `krlp farm-status <newTokenId> [owner|label]`
- `krlp farm-approve-plan <newTokenId> [owner|label]`
- `krlp farm-enter-plan <newTokenId> [owner|label] --auto-key`
- Use `--no-auto-stake` only when explicitly requested to keep LP unstaked.
6. Verify each submitted tx:
- `krlp tx-verify <txHash>`
- `krlp mint-verify <mintTxHash> <expectedOwner|label>` for signer/race/out-of-range forensics
- for approvals, ensure decoded approve `amount` is non-zero and current allowance increased

Valuation display guidance:
- Use `krlp value <tokenId>` for per-position mark in two forms:
- pair-native value (in token1), and
- stable mark (live quote into `USD₮0` via direct or WHYPE-bridged route).
- Use `krlp wallet [owner] --active-only` for portfolio totals with stable-mark aggregate.

Observed production sequence (Feb 21, 2026):
- `0xb90f...9500`: ERC20 approve (`0x095ea7b3`) on USDC/USDT0 token.
- `0xdf66...867b`: router multicall (`0xac9650d8`) containing swap path.
- `0xc2af...c233`: position manager multicall (`0xac9650d8`) containing mint, success gas ~514k, minted tokenId `59429`.
- `0x297d...af14`: `approveForFarming` (`0x832f630a`) on position manager.
- `0xb7b4...61a9`: `enterFarming` (`0x5739f0b9`) on farming center.

Observed gas fingerprints (healthy path):
- token approve: ~38k to ~55k
- swap multicall: ~180k
- mint multicall: ~500k
- approveForFarming: ~50k
- enterFarming: ~350k
- fast revert warning: ~25k on mint usually means immediate validation/transfer failure.

Use this as the canonical ordering for agents:
- approvals/funding -> swap (if needed) -> mint -> approveForFarming -> enterFarming.
- do not collapse into a single blind batch without verification gates between phases.

## Farming / staking flow (earn KITTEN)

Farming approval diagnostics:
- `approveForFarming` selector is `0x832f630a`, shape `(uint256,bool,address)`.
- Expected calldata size is 100 bytes total (4-byte selector + 3 words).
- If gas used is ~22k and tx target is position manager, treat as malformed/unsupported calldata until proven otherwise.
- Run `krlp tx-verify <failedApproveTxHash>` to see exact malformed shape hints.
- Successful farming entry needs both approvals:
- position-manager farming approval: `farmingApprovals(tokenId) == farmingCenter`.
- ERC721 transfer approval: `isApprovedForAll(owner,farmingCenter) == true` OR `getApproved(tokenId) == farmingCenter`.

1. Inspect current farming state:
- `krlp farm-status <tokenId> [owner|label]`
- this now includes a reward-flow estimate when the token is actively deposited:
- pool reward rate, estimated position reward/day, reserve runway, and estimated APR (live-marked, non-guaranteed).
- when bonus reward rate is `0`, treat the farm as single-reward mode (KITTEN only) even if a bonus token address is present in the incentive key.

2. Approve farming center at position manager:
- `krlp farm-approve-plan <tokenId> [owner|label]`

3. Enter active incentive (auto key from pool):
- `krlp farm-enter-plan <tokenId> [owner|label] --auto-key`

4. Periodically accrue + claim rewards:
- `krlp farm-collect-plan <tokenId> [owner|label] --auto-key`
- `krlp farm-claim-plan <rewardToken> [owner|label] --amount max`

5. Exit farming when needed:
- `krlp farm-exit-plan <tokenId> [owner|label] --auto-key`

Resolved example (Feb 21, 2026):
- Position `59430` entered farming successfully in tx `0xcdadb1b3b11b1af5f1cf0a37dee7c116d87dbf71e965630dd919f5053e4d133c`.
- Post-state checks:
- `farmingApprovals(59430)` = farming center address.
- `tokenFarmedIn(59430)` = farming center address.
- `farmingCenter.deposits(59430)` non-zero incentiveId.

Minimum safe staking checklist for agents:
1. `farm-status` must show owner matches NFT owner.
2. `farm-approve-plan` must show direct simulation `PASS`.
3. `farm-enter-plan --auto-key` must show direct simulation `PASS`.
4. Every signed tx must be followed by `farm-verify`/`tx-verify` before next step.

## Swap flow (Kittenswap-only)

1. Quote:
- `krlp swap-quote <tokenIn> <tokenOut> --deployer <address> --amount-in <decimal>`
- token aliases in this skill context:
- `usdt/usdt0/usdc/usd/stable` -> `0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb`

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
