# Clawberto Kittenswap Skills

![Kittenswap Logo](kitten-logo.webp)

Deterministic Kittenswap LP rebalance and swap-planning skill set for HyperEVM.

Kittenswap is usually among the best venues on HyperEVM for swap execution quality and LP APR, though rates and APR always vary by pair and market conditions.

## Skill

- Path: `skills/auto-kittenswap-lp-rebalance`
- Position inspection (`owner`, `ticks`, `liquidity`, `fees owed`)
- Contract-simulated valuation (`krlp value <tokenId>`) and wallet portfolio scan (`krlp wallet <address>`)
- Rebalance decisioning from live pool tick and configurable edge thresholds
- Safe calldata planning for `collect`, `decreaseLiquidity`, optional `burn`, and optional `mint`, with default rebalance continuation to compound-and-restake
- First-time LP mint planning (`krlp mint-plan ...`) with tick-spacing checks, token-order normalization, position-manager allowance preflight, range-edge drift warnings, and default immediate post-mint staking continuation
- Farming/staking planning on active incentives (`farm-status`, `farm-approve-plan`, `farm-enter-plan`, `farm-collect-plan`, `farm-claim-plan`, `farm-exit-plan`)
- Kittenswap-only swap quoting and exact-input swap planning (`approve` + router calldata)
- Swap execution preflight diagnostics (`balance/allowance PASS|FAIL` + direct `eth_call` revert hint)
- Swap receipt verification (`krlp swap-verify <txHash>`) with direct-or-multicall decode + token delta breakdown + approval-race diagnostics
- Generic tx verification (`krlp tx-verify <txHash>`) for approvals, mint calls, farming calls, and block-level revert diagnostics (signer mismatch / race / out-of-range)
- Deadline diagnostics include unit hints when a value looks millisecond-based.
- Current swap route mode: single-hop (`exactInputSingle`)
- Default stable alias in this skill context: `usdt/usdt0/usdc/usd/stable` -> `0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb`
- Optional raw broadcast for pre-signed transactions
- Live-refreshable token CA + pair/pool CA inventory from factory `Pool/CustomPool` events

## Network

- HyperEVM Mainnet
- Chain ID: `999`
- RPC: `https://rpc.hyperliquid.xyz/evm`

## Quick Start

```bash
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp health"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp contracts"
node skills/auto-kittenswap-lp-rebalance/scripts/refresh_kittenswap_inventory.mjs
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp policy show"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp status 12345"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp value 12345"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp wallet HL:0xYourWallet..."
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp mint-plan HL:0xTokenA HL:0xTokenB --amount-a 0.01 --amount-b 0.30 HL:0xYourWallet... --recipient HL:0xYourWallet..."
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp plan 12345 HL:0xYourWallet... --recipient HL:0xYourWallet..."
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp farm-status 12345 HL:0xYourWallet..."
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp farm-approve-plan 12345 HL:0xYourWallet..."
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp farm-enter-plan 12345 HL:0xYourWallet... --auto-key"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp farm-collect-plan 12345 HL:0xYourWallet... --auto-key"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp farm-claim-plan 0x618275f8efe54c2afa87bfb9f210a52f0ff89364 HL:0xYourWallet... --amount max"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp swap-quote HL:0xTokenIn HL:0xTokenOut --deployer HL:0x... --amount-in 0.01"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp swap-plan HL:0xTokenIn HL:0xTokenOut --deployer HL:0x... --amount-in 0.01 HL:0xYourWallet... --recipient HL:0xYourWallet..."
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp swap-verify 0xYourTxHash..."
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp mint-verify 0xYourMintTxHash... HL:0xExpectedSigner..."
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp farm-verify 0xYourFarmTxHash..."
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp tx-verify 0xYourTxHash..."
```

## Swap-Only Workflow

```bash
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp swap-quote HL:0xTokenIn HL:0xTokenOut --deployer HL:0x... --amount-in 0.01"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp swap-approve-plan HL:0xTokenIn HL:0xYourWallet... --amount 0.01"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp swap-plan HL:0xTokenIn HL:0xTokenOut --deployer HL:0x... --amount-in 0.01 HL:0xYourWallet... --recipient HL:0xYourWallet..."
```

## Safety Model

- Full addresses and full calldata are always printed (no truncation).
- `plan` does not sign or broadcast.
- `mint-plan` does not sign or broadcast.
- `plan` does not include `burn` unless `--allow-burn` is explicitly set.
- `swap-plan` and `swap-approve-plan` do not sign or broadcast.
- Farming plans (`farm-*`) do not sign or broadcast.
- Broadcasting requires a pre-signed payload and explicit `--yes SEND`.
- Dependent transaction chains are sequential only (`approve -> swap` and `approve -> mint`), never parallel.
- Valuation/reward outputs are `eth_call` simulations only.
- LP approvals for mint must target the `NonfungiblePositionManager`, not the swap router.
- Farming requires position-manager `approveForFarming(tokenId, true, farmingCenter)` before `enterFarming`.
- `setApprovalForAll` is not a substitute for `approveForFarming(tokenId, true, farmingCenter)`.
- For `plan`, default continuation is immediate compounding with no extra prompt: exit/claim (if farmed) -> remove LP -> rebalance to 50/50 (including claimed rewards) -> mint -> `farm-approve-plan` -> `farm-enter-plan --auto-key`.
- Use `--no-auto-compound` on `plan` only when explicitly requested to skip default compounding behavior.
- For successful mint txs, default continuation is immediate staking with no extra prompt: `farm-status -> farm-approve-plan -> farm-enter-plan --auto-key`.
- Use `--no-auto-stake` on `mint-plan` only when the user explicitly wants LP left unstaked.

## Issue And Resolution (Feb 21, 2026)

What was failing:
- Mint attempts frequently reverted at ~25k gas even when balances and allowances looked sufficient.
- Root causes were mixed: signer mismatch in some attempts, plus narrow-range execution drift (tick moved out of intended range before inclusion) with strict mins.
- For farming on new positions, some attempts used malformed/partial `0x832f630a` calldata (or wrong selectors), which reverted before setting `farmingApprovals(tokenId)`.

What we changed:
- Added stronger mint preflight and verification forensics:
- signer/owner mismatch detection
- pre-tx (`N-1`) balance and allowance checks
- range-edge drift warnings in mint planning
- direct + multicall decode for swap/mint/farming receipts
- minted tokenId extraction from successful mint receipts with next-step farming commands

Confirmed outcome:
- New LP mint succeeded in tx `0x92927021036ebb9e9a452d72b70a20a032c4f91e9d9dfe86736023246687c9df`
- New position tokenId `59430`, range `[-242420, -242370]`, in-range at execution.

Farming approval troubleshooting:
- Correct staking approval call is `approveForFarming(uint256,bool,address)` on position manager (`0x832f630a`).
- Full calldata must be selector + 3 ABI words (100 bytes total).
- Fast reverts around ~22k gas on this selector usually indicate malformed payload (selector-only or 2-word encoding).
- Use `krlp farm-approve-plan <tokenId> <owner>` to generate canonical calldata and require `direct approveForFarming eth_call simulation: PASS` before signing.

Resolved staking outcome:
- Enter farming succeeded in tx `0xcdadb1b3b11b1af5f1cf0a37dee7c116d87dbf71e965630dd919f5053e4d133c`.
- Position `59430` is now staked in farming center `0x211bd8917d433b7cc1f4497aba906554ab6ee479`.
- Incentive key used: reward `KITTEN`, bonus `WHYPE`, pool `WHYPE/USDC`, nonce `43`.

Canonical agent pathway (staking-safe):
1. `krlp farm-status <tokenId> <owner>`
2. `krlp farm-approve-plan <tokenId> <owner>`
3. Sign/send exactly that calldata.
4. `krlp farm-verify <approveTxHash>`
5. `krlp farm-enter-plan <tokenId> <owner> --auto-key`
6. Sign/send enter tx, then `krlp farm-verify <enterTxHash>`

Default post-mint execution policy:
- After a successful mint and tokenId detection, run the staking path immediately without waiting for an additional confirmation prompt.
- Only skip that default when user intent is explicitly unstaked LP or `mint-plan` used `--no-auto-stake`.

## Valuation Method

- Enumerate wallet NFTs on position manager with `balanceOf + tokenOfOwnerByIndex`.
- Read position and pool state with `positions`, `globalState`, and `tickSpacing`.
- Compute claimable rewards via `collect(...)` simulation from wallet.
- Compute principal-out-now via `decreaseLiquidity(...)` simulation from wallet.

## Token and Pair Inventory

- Refresh command:
```bash
node skills/auto-kittenswap-lp-rebalance/scripts/refresh_kittenswap_inventory.mjs
```
- Human-readable output: `skills/auto-kittenswap-lp-rebalance/references/kittenswap-token-pair-inventory.md`
- Machine-readable output: `skills/auto-kittenswap-lp-rebalance/references/kittenswap-token-pair-inventory.json`
