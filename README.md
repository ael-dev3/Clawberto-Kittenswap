# Clawberto Kittenswap Skills

![Kittenswap Logo](kitten-logo.webp)

Production skill set for deterministic Kittenswap LP operations on HyperEVM:
- position inspection
- rebalance planning
- swap planning
- farming planning
- forensic tx verification

This repository is designed for weak-LLM-safe execution: no hand-encoded calldata, strict simulation gates, and explicit `DO NOT SEND` conditions.

## Table of Contents

- [Project Scope](#project-scope)
- [Network and Contracts](#network-and-contracts)
- [Token Defaults and Aliases](#token-defaults-and-aliases)
- [Quick Start](#quick-start)
- [Strict Execution Protocol](#strict-execution-protocol)
- [Core Workflows](#core-workflows)
- [Failure Triage](#failure-triage)
- [Major Obstacles Resolved](#major-obstacles-resolved)
- [Repository Layout](#repository-layout)
- [Validation Commands](#validation-commands)

## Project Scope

| Item | Value |
| --- | --- |
| Chain | HyperEVM Mainnet |
| Chain ID | `999` |
| RPC | `https://rpc.hyperliquid.xyz/evm` |
| Main skill path | `skills/auto-kittenswap-lp-rebalance` |
| CLI entrypoint | `skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs` |

## Network and Contracts

| Contract | Address |
| --- | --- |
| Factory | `0x5f95e92c338e6453111fc55ee66d4aafcce661a7` |
| QuoterV2 | `0xc58874216afe47779aded27b8aad77e8bd6ebebb` |
| SwapRouter | `0x4e73e421480a7e0c24fb3c11019254ede194f736` |
| NonfungiblePositionManager | `0x9ea4459c8defbf561495d95414b9cf1e2242a3e2` |
| FarmingCenter | `0x211bd8917d433b7cc1f4497aba906554ab6ee479` |
| AlgebraEternalFarming | `0xf3b57fe4d5d0927c3a5e549cb6af1866687e2d62` |

## Token Defaults and Aliases

| Purpose | Address |
| --- | --- |
| WHYPE | `0x5555555555555555555555555555555555555555` |
| Default stable token (`USDT0/USDC` context) | `0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb` |
| KITTEN | `0x618275f8efe54c2afa87bfb9f210a52f0ff89364` |
| UETH | `0xbe6727b535545c67d5caa73dea54865b92cf7907` |

Swap aliases:
- `usdt`, `usdt0`, `usdc`, `usd`, `stable` -> default stable token above
- `whype` -> `0x5555555555555555555555555555555555555555`
- `kitten`, `kit` -> `0x618275f8efe54c2afa87bfb9f210a52f0ff89364`
- `ueth`, `eth` -> `0xbe6727b535545c67d5caa73dea54865b92cf7907`

## Quick Start

```bash
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp health"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp contracts"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp help"
```

Set a default account:

```bash
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp account add main 0xYourAddress --default"
```

## Strict Execution Protocol

Apply this sequence every time:

1. Generate plan/status first. Never start by broadcasting.
2. If any output shows `BLOCKED`, stop.
3. If simulation is not `PASS`, stop.
4. Send only exact calldata from `krlp ...-plan` output.
5. Never hand-edit selectors, ABI words, or hex payloads.
6. Check per-step selector guards before send:
   - `collect`: `0xfc6f7865`
   - `decreaseLiquidity`: `0x0c49ccbe`
   - `burn`: `0x42966c68`
7. Run `krlp tx-verify <txHash>` after every broadcast.
8. Unknown-selector + low-gas reverts on `NonfungiblePositionManager` are treated as client call construction errors by default, not zombie-state proof.

## Core Workflows

### Rebalance Existing LP (Default Compound + Restake)

```bash
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp plan <tokenId> <owner> --recipient <owner>"
```

Execution rules:
1. Send old-position steps only if `old-position execution gate: PASS`.
2. Respect selector guard output for each step.
3. If position is staked, exit/claim first using `farm-*` plans.
4. Rebalance inventory to 50/50 notional.
5. Mint replacement position and stake immediately (default behavior).

Opt-out:
- `--no-auto-compound` disables default compound-and-restake continuation.

### Withdraw / Close LP (Exit-Only)

```bash
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp withdraw <tokenId> <owner> --recipient <owner>"
```

Execution rules:
1. Use `withdraw` for close intents (`withdraw 59442` now resolves directly).
2. If owner is omitted and no default account is configured, `withdraw` falls back to on-chain `ownerOf(tokenId)`.
3. If `staked status` is staked, run `farm-exit-plan` first, verify tx, then re-run `withdraw`.
4. Send only when `execution gate: PASS`.
5. Keep strict order: `collect -> decreaseLiquidity -> collect` (`-> burn` only with `--allow-burn`).
6. Run `krlp tx-verify <txHash>` after each broadcast.

### Heartbeat Rebalance

```bash
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp heartbeat <tokenId> <owner> --recipient <owner>"
```

Defaults:
- edge threshold: `500` bps (5%)
- width bump on triggered rebalance: `+100` ticks

### First Mint + Stake

```bash
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp mint-plan <tokenA> <tokenB> --amount-a <A> --amount-b <B> <owner> --recipient <owner>"
```

Default continuation after successful mint:
- `farm-status -> farm-approve-plan -> farm-enter-plan --auto-key`

Opt-out:
- `--no-auto-stake`

### Farming Operations

Canonical staking truth source:
- `positionManager.tokenFarmedIn(tokenId)` and `farmingCenter.deposits(tokenId)`

Recommended checks:

```bash
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp farm-staked-summary <owner> --active-only"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp farm-status <tokenId> <owner>"
```

### APR Estimation by Tick Range

```bash
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp apr"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp apr <tokenId>"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp apr --range-ticks 300"
```

Shows:
- Current HYPE price (from on-chain sqrtPriceX96)
- Pool TVL and fee rate (verified on-chain)
- APR table for ±50/100/200/300/500/750/1000 ticks with concentration factor
- If tokenId provided: position-specific APR and uncollected fees
- Fee generation sampling (detects active vs inactive pool)

### Swap Operations

```bash
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp swap-quote <tokenIn> <tokenOut> --amount-in <amt>"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp swap-approve-plan <tokenIn> <owner> --amount <amt>"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp swap-plan <tokenIn> <tokenOut> --amount-in <amt> <owner>"
```

KITTEN routing policy:
- prefer `KITTEN <-> WHYPE`
- for `KITTEN <-> stable`, route via WHYPE in two steps

## Failure Triage

| Symptom | Typical Cause | Required Action |
| --- | --- | --- |
| `~22k-26k gas` revert on position manager with unknown selector | wrong/malformed selector or ABI payload | regenerate plan and resend only canonical calldata |
| `decreaseLiquidity` revert with huge liquidity in decode | shifted/malformed calldata word | use plan-generated `0x0c49ccbe` payload unchanged |
| `collect` revert with empty reason and zero maxima | invalid `amount0Max=0` and `amount1Max=0` | use canonical collect calldata (`maxUint128` fields) |
| `Invalid incentiveId` on farm exit/collect | token not currently staked or stale key tuple | run `farm-status`; only run farm exit/collect when staking preconditions pass |
| swap sim pass but execution low-gas empty revert | malformed swap payload | require canonical byte length and regenerate `swap-plan` calldata |
| agent output appears compacted/truncated during withdraw run | oversized/mixed workflow output in runtime context | switch to `krlp withdraw <tokenId> <owner>` (exit-only concise path), execute step-by-step with `krlp tx-verify` after each tx |

## Major Obstacles Resolved

| Obstacle | Root Cause | Resolution | Evidence |
| --- | --- | --- | --- |
| LP removal looked "stuck" after farming exit | repeated malformed/unsupported position-manager selectors | added selector guardrails, execution gates, and `CLIENT_CALL_INVALID` classification in `tx-verify` | failing txs: `0xdfb55a8b310980dd0cd98248f6ad8cad4fafc0e6fb650876d0fb77e7e3da45d3`, `0xa71aab7c5ee96b63af7092467f66334b53cb71f8f1151acca4a0e2d754ccf3a3`, `0xc8d149d111c5dadc4a4b71db1305f384ac75a8ef75bbc6c84f333efea74297d0` |
| `decreaseLiquidity` kept reverting despite gate confusion | malformed liquidity word in sent calldata, not contract state | enforced per-step decode guards and liquidity match checks | failing tx: `0x354047617e5b20393eb6eabb3a9f819781881a1d3950d046b3340a75fa74471c`; operational outcome (Feb 22, 2026): position `59437` removed with canonical `0x0c49ccbe` path |
| farming exits/collects failing with `Invalid incentiveId` | attempts sent while token not staked or with key mismatch | added hard farm execution gate and deposit-aware key checks | failing tx: `0x205216d0ac6dfb3d1a00296769d4877948f2118e5c97f9355cb51ed92488eb0e` |
| close-position intent (`withdraw 59442`) was ambiguous for NL parser | no first-class withdraw command pathway | added deterministic `withdraw|withdraw-plan` exit-only flow + NL intent mapping + compact step-by-step runbook output | operational guardrail: use `krlp withdraw <tokenId> <owner> --recipient <owner>` and require `execution gate: PASS` |

## Repository Layout

- `skills/auto-kittenswap-lp-rebalance/SKILL.md`: canonical operating rules
- `HEARTBEAT.md`: heartbeat runbook
- `skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs`: CLI parser, planners, verification
- `skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_api.mjs`: RPC + ABI/calldata helpers
- `skills/auto-kittenswap-lp-rebalance/scripts/refresh_kittenswap_inventory.mjs`: inventory refresh
- `skills/auto-kittenswap-lp-rebalance/references/`: protocol and inventory references

## Validation Commands

```bash
node --check skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs
node --check skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_api.mjs
node --check skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_config.mjs
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp help"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp withdraw 59442 <owner>"
```

## Operational Notes

- Internal/private test artifacts are intentionally not hosted in this repository.
- Always run local simulation and verification before signing/broadcasting.
