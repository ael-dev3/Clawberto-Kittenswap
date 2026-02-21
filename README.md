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

## Key Capabilities

- Position status and valuation (`krlp position`, `krlp status`, `krlp value`, `krlp wallet`)
- Rebalance plan generation with deterministic step ordering (`collect -> decrease -> collect -> mint`)
- Default compound-and-restake continuation for rebalance plans
- First-time mint planning with default immediate stake continuation
- Swap quote/approve/plan/verify flow with block-safe dependency checks
- Farming lifecycle planning (`farm-status`, `farm-approve-plan`, `farm-enter-plan`, `farm-collect-plan`, `farm-claim-plan`, `farm-exit-plan`)
- Receipt verification with calldata decoding and forensic hints (`swap-verify`, `tx-verify`)

## Standard Operating Flows

### 1. Rebalance (Default: Compound And Restake)

1. Run `krlp plan <tokenId> <owner> --recipient <owner> [--amount0 X --amount1 Y]`.
2. If staked, exit and claim rewards first.
3. Remove principal + fees from old position.
4. Rebalance inventory to 50/50 notional across pair tokens.
5. Include claimed rewards (KITTEN/bonus) in rebalance inventory.
6. Mint replacement position.
7. Stake replacement position immediately (`farm-approve-plan -> farm-enter-plan --auto-key`).

Opt-out flag: `--no-auto-compound`.

### 2. First-Time Mint (Default: Stake Immediately)

1. Run `krlp mint-plan ...` with explicit amounts and range.
2. Complete required approvals.
3. Submit mint.
4. Stake newly minted NFT immediately.

Opt-out flag: `--no-auto-stake`.

### 3. Swap Execution (Sequential Dependency Model)

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
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp plan 12345 HL:0xYourWallet... --recipient HL:0xYourWallet..."
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp swap-quote usdt 0x5555555555555555555555555555555555555555 --deployer 0x0000000000000000000000000000000000000000 --amount-in 1.0"
```

## Safety Model

- Dry-run planning only for `plan`, `mint-plan`, `swap-plan`, and `farm-*` commands
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
| Mint reverts near ~25k gas | Signer mismatch and range-edge execution drift in some attempts | Added signer/range preflight forensics, replay diagnostics, and stronger mint simulation checks | Successful mint: `0x92927021036ebb9e9a452d72b70a20a032c4f91e9d9dfe86736023246687c9df` |
| Farming approval reverts near ~22k gas | Malformed `approveForFarming` calldata (selector-only/2-word variants) | Added strict decode + malformed-shape diagnostics and canonical generation path | Successful enter farming: `0xcdadb1b3b11b1af5f1cf0a37dee7c116d87dbf71e965630dd919f5053e4d133c` |
| Ambiguous post-mint actions | Inconsistent operator follow-through | Defaulted post-mint to immediate staking (opt-out only) | Stable production staking path documented in skill |
| Inconsistent rebalance follow-through | Manual discretion after plan output | Defaulted rebalance continuation to compound-and-restake with 50/50 rebalance guidance | `krlp plan` now prints full default sequence |

## Validation

Recommended local checks before pushing changes:

```bash
node --check skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs
node --check skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_api.mjs
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp help"
```

## Repository Structure

- `skills/auto-kittenswap-lp-rebalance/SKILL.md` - primary skill contract and operating rules
- `skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs` - command parser, planner outputs, and verifiers
- `skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_api.mjs` - RPC helpers and calldata builders
- `skills/auto-kittenswap-lp-rebalance/scripts/refresh_kittenswap_inventory.mjs` - token/pool inventory refresh
- `skills/auto-kittenswap-lp-rebalance/references/rebalance-playbook.md` - operational playbook
- `skills/auto-kittenswap-lp-rebalance/references/kittenswap-token-pair-inventory.json` - machine-readable inventory

## Operational Notes

- Internal/private test artifacts are intentionally not hosted in this repository.
- Use local simulations and verifiers before signing and broadcasting.
