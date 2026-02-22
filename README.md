# Clawberto Kittenswap Skills

![Kittenswap Logo](kitten-logo.webp)

Deterministic Kittenswap LP management skills for HyperEVM: inspect positions, plan rebalances, plan swaps, verify receipts, and enforce safe execution sequencing.

## Overview

This repository packages the production skill used by Clawberto/OpenClaw agents for concentrated-liquidity operations on Kittenswap.

Primary goals:

- Deterministic, auditable calldata generation
- Explicit preflight/simulation gates before signing
- Safe defaults for compounding and staking workflows
- Fast root-cause diagnostics for failed transactions

## Scope

| Item | Value |
| --- | --- |
| Network | HyperEVM Mainnet |
| Chain ID | `999` |
| RPC | `https://rpc.hyperliquid.xyz/evm` |
| Main skill path | `skills/auto-kittenswap-lp-rebalance` |

## Core Contracts

| Contract | Address |
| --- | --- |
| Factory | `0x5f95e92c338e6453111fc55ee66d4aafcce661a7` |
| QuoterV2 | `0xc58874216afe47779aded27b8aad77e8bd6ebebb` |
| Router | `0x4e73e421480a7e0c24fb3c11019254ede194f736` |
| NonfungiblePositionManager | `0x9ea4459c8defbf561495d95414b9cf1e2242a3e2` |
| FarmingCenter | `0x211bd8917d433b7cc1f4497aba906554ab6ee479` |
| AlgebraEternalFarming | `0xf3b57fe4d5d0927c3a5e549cb6af1866687e2d62` |

## Token Defaults And Aliases

| Purpose | Address |
| --- | --- |
| WHYPE | `0x5555555555555555555555555555555555555555` |
| Default USD stable token | `0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb` |

Swap command aliases automatically resolve to the default stable token:

- `usdt`
- `usdt0`
- `usdc`
- `usd`
- `stable`

Additional swap aliases:

- `whype` -> `0x5555555555555555555555555555555555555555`
- `kitten` / `kit` -> `0x618275f8efe54c2afa87bfb9f210a52f0ff89364`
- `ueth` / `eth` -> `0xbe6727b535545c67d5caa73dea54865b92cf7907`

## KITTEN Swap Routing

- Operational default is `KITTEN <-> WHYPE` as the primary executable route.
- For `KITTEN <-> stable`, prefer two-step routing through WHYPE:
  - `KITTEN -> WHYPE`
  - `WHYPE -> stable`
- Direct KITTEN/stable one-hop pools may exist but can be illiquid and revert at execution time.
- KITTEN routes can show high effective trade costs; up to ~5% can be normal and is not by itself a contract bug.

## Key Capabilities

- Position status and valuation (`krlp position`, `krlp status`, `krlp value`, `krlp wallet`)
- Rebalance plan generation with deterministic step ordering (`collect -> decrease -> collect -> mint`)
- Default compound-and-restake continuation for rebalance plans
- Heartbeat orchestration with deterministic branching (`HOLD` vs `REBALANCE_COMPOUND_RESTAKE`)
- First-time mint planning with default immediate stake continuation
- Swap quote/approve/plan/verify flow with block-safe dependency checks
- Farming lifecycle planning (`farm-status`, `farm-approve-plan`, `farm-enter-plan`, `farm-collect-plan`, `farm-claim-plan`, `farm-exit-plan`)
- Canonical multi-position staking audit (`farm-staked-summary`) for weak-LLM-safe execution gating
- Deposit-aware farming key resolution for `farm-collect-plan` and `farm-exit-plan` (`--auto-key`)
- Receipt verification with calldata decoding and forensic hints (`swap-verify`, `tx-verify`)

## Standard Operating Flows

### 1. Rebalance (Default: Compound And Restake)

1. Run `krlp plan <tokenId> <owner> --recipient <owner> [--amount0 X --amount1 Y]`.
2. If staked, exit and claim rewards first.
3. Remove principal + fees from old position.
4. Rebalance inventory to 50/50 notional across pair tokens.
5. Include claimed KITTEN rewards in rebalance inventory (include bonus token only when `farm-status` shows a non-zero bonus rate).
6. Mint replacement position.
7. Stake replacement position immediately (`farm-approve-plan -> farm-enter-plan --auto-key`).

Opt-out flag: `--no-auto-compound`.

### 2. Heartbeat Automation (Default: Anti-Churn + Slow Widening)

1. Run `krlp heartbeat <tokenId> <owner> --recipient <owner>`.
2. Rebalance is triggered only when out-of-range or within `5%` edge headroom (`500 bps`).
3. On triggered rebalance, replacement width grows by `+100` ticks (tick-spacing aligned).
4. If heartbeat returns `HOLD`, skip LP churn and optionally harvest rewards only.
5. Follow exact branch commands printed by heartbeat output.

Canonical runbook: `HEARTBEAT.md`.

### 2A. Canonical Staked Check (Before Any Farm Action)

1. Run `krlp farm-staked-summary <owner> --active-only`.
2. Treat a position as staked in Kittenswap only when:
   - `statusCode = STAKED_KITTENSWAP`
   - `stakedInKittenswap = YES`
3. If `statusCode` is anything else, do not run `farm-exit-plan` or `farm-collect-plan` until resolved.

### 3. First-Time Mint (Default: Stake Immediately)

1. Run `krlp mint-plan ...` with explicit amounts and range.
2. Complete required approvals.
3. Submit mint.
4. Stake newly minted NFT immediately.

Opt-out flag: `--no-auto-stake`.

### 4. Swap Execution (Sequential Dependency Model)

1. `krlp swap-quote ...`
2. `krlp swap-approve-plan ...` (if required)
3. `krlp swap-plan ...`
4. Submit approvals first, wait for success + confirmation block.
5. Re-run plan, require simulation pass, then submit swap.

## Quick Start

```bash
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp health"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp contracts"
node skills/auto-kittenswap-lp-rebalance/scripts/refresh_kittenswap_inventory.mjs
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp policy show"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp status 12345"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp farm-staked-summary HL:0xYourWallet... --active-only"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp heartbeat 12345 HL:0xYourWallet... --recipient HL:0xYourWallet..."
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp plan 12345 HL:0xYourWallet... --recipient HL:0xYourWallet..."
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp swap-quote usdt 0x5555555555555555555555555555555555555555 --deployer 0x0000000000000000000000000000000000000000 --amount-in 1.0"
```

## Safety Model

- Dry-run planning only for `plan`, `mint-plan`, `swap-plan`, and `farm-*` commands
- `heartbeat` is orchestration-only (read/sim guidance, no signing/broadcast)
- Raw broadcast requires explicit pre-signed tx + `--yes SEND`
- Full addresses and full calldata output (no truncation)
- No private key handling in skill logic
- LP token approvals target `NonfungiblePositionManager` (not router)
- Farming requires `approveForFarming(tokenId, true, farmingCenter)`
- `setApprovalForAll` is not a replacement for farming approval
- Dependent transaction chains are sequential, never parallel

## Major Bug Resolutions

### Feb 21, 2026 Production Incidents

| Incident | Root Cause | Resolution | Evidence |
| --- | --- | --- | --- |
| Mint reverts with `Price slippage check` | Desired ratio/min bounds incompatible with execution price | Added explicit slippage classification and mitigation guidance (ratio alignment, range/slippage tuning, strict simulation gate) | Failing tx example: `0x469f015fe7577ea18378138b3597f72107a9503de0eca96d08493b9a7b521d49` |
| Mint reverts near ~25k gas | Malformed/truncated direct mint calldata in some attempts | Added direct selector-level malformed calldata diagnostics and canonical regeneration path via `mint-plan`/`plan` | Failing tx example: `0xfc838637769b8a2f75fd8e40870d787365f6520154ce1c89677ee3ff4f21d41a` |
| Farming approval reverts near ~22k gas | Malformed `approveForFarming` calldata (selector-only/2-word variants) | Added strict decode + malformed-shape diagnostics and canonical generation path | Successful enter farming: `0xcdadb1b3b11b1af5f1cf0a37dee7c116d87dbf71e965630dd919f5053e4d133c` |
| Farming collect/exit silent reverts | `--auto-key` previously used only current pool incentive key; staked deposits can be tied to older key tuples | Added deposit-aware key resolution (`deposits(tokenId)` + explorer-backed historical key recovery + bounded nonce scan), plus direct collect/exit preflight simulation and explicit blockers | Failing tx pattern example: repeated ~22,630 gas `FarmingCenter` reverts with empty reason |
| SwapRouter silent reverts near ~23k gas | Swap submitted with `amountIn` above both wallet balance and router allowance (or malformed low-level swap payload) | Added swap-plan execution gate (`BLOCKED|PASS`), explicit blocker remediation steps, combined allowance+balance root-cause detection in `swap-verify`, and low-gas early-abort malformed-calldata guidance | Failing tx example: `0x9ddfedc68005a35b5197a09c7dcb2bc880ffac961e04e58f65e27813692b658d` |
| SwapRouter low-gas empty reverts with malformed payload | Oversized/misaligned ABI word can spill into `limitSqrtPrice` and violate `uint160` decode, causing immediate revert | Enforced strict ABI word bounds in encoder, added `uint160` range check for `limitSqrtPrice`, and added calldata length/canonical checks (`260 bytes expected`) in swap planning + verification | Failing tx: `0x3dd6c645d30b5d4dfef2c2d0be0e77dd38d5ec487e73aaf26177e6643cd59acb`; resolved tx: `0x113ba1c00b0ee8f173a54c06913569462ef8b85390c5ad3a7fc7bdeed6e4f11c` |
| Ambiguous post-mint actions | Inconsistent operator follow-through | Defaulted post-mint to immediate staking (opt-out only) | Stable production staking path documented in skill |
| Inconsistent rebalance follow-through | Manual discretion after plan output | Defaulted rebalance continuation to compound-and-restake with 50/50 rebalance guidance | `krlp plan` now prints full default sequence |

### Feb 22, 2026 KITTEN Swap Incident (Resolved)

What caused the error:

- The failing KITTEN->WHYPE router transaction used malformed `exactInputSingle` calldata.
- On-chain decode showed `262` calldata bytes instead of canonical `260`.
- The malformed payload also failed canonical `limitSqrtPrice` `uint160` shape checks (high bits non-zero).
- This produced a low-gas, empty-reason router revert pattern (`~23k gas`, no logs), which can look like a broken pool.
- Important: this was not a pool rule requiring a specific non-zero `amountOutMinimum`; the malformed payload shifted/corrupted field decoding (including `amountOutMinimum`).

What worked:

- Regenerate calldata from fresh `krlp swap-plan` output (no manual edits, no truncation/re-encoding).
- Require all of the following before signing:
  - `direct swap eth_call simulation: PASS`
  - `execution gate: PASS`
  - `exactInputSingle calldata length check: PASS` (`260` bytes)
- Verify with `krlp swap-verify <txHash>` after broadcast.

Outcome:

- Successful execution confirmed on `February 22, 2026`:
  - tx: `0x113ba1c00b0ee8f173a54c06913569462ef8b85390c5ad3a7fc7bdeed6e4f11c`
  - swap: `30 KITTEN -> 0.001154225779041014 WHYPE`

## Validation

Recommended local checks before pushing changes:

```bash
node --check skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs
node --check skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_api.mjs
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp help"
```

## Repository Structure

- `skills/auto-kittenswap-lp-rebalance/SKILL.md` - primary skill contract and operating rules
- `HEARTBEAT.md` - heartbeat state-machine runbook for weak LLM operators
- `skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs` - command parser, planner outputs, and verifiers
- `skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_api.mjs` - RPC helpers and calldata builders
- `skills/auto-kittenswap-lp-rebalance/scripts/refresh_kittenswap_inventory.mjs` - token/pool inventory refresh
- `skills/auto-kittenswap-lp-rebalance/references/rebalance-playbook.md` - operational playbook
- `skills/auto-kittenswap-lp-rebalance/references/kittenswap-token-pair-inventory.json` - machine-readable inventory

## Operational Notes

- Internal/private test artifacts are intentionally not hosted in this repository.
- Use local simulations and verifiers before signing and broadcasting.
