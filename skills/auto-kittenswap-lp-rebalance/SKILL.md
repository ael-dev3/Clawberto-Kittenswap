---
name: auto-kittenswap-lp-rebalance
description: Kittenswap concentrated-liquidity rebalance, heartbeat orchestration, first-time LP mint planning, and swap execution-planning skill for HyperEVM mainnet (chain id 999). Use when users need deterministic LP position inspection, range-health checks, heartbeat-triggered decisioning (`HOLD` vs `REBALANCE_COMPOUND_RESTAKE`), LP mint preflight, or swap-only flows (quote, approval plan, swap calldata plan, signed raw broadcast). Default policy after successful LP mint is immediate farming continuation (`approveForFarming -> enterFarming`) unless explicitly disabled. Default rebalance policy is compound-and-restake (`exit/claim -> 50/50 rebalance including rewards -> mint -> enterFarming`) unless explicitly disabled. Heartbeat defaults to anti-churn edge threshold `500` bps (5%) and gradual width increase `+100` ticks on triggered rebalances. Supports `krlp ...` and `/krlp ...` commands with full-address/full-calldata output and policy/account aliases stored locally.
---

# Auto Kittenswap LP Rebalance

Inspect and plan Kittenswap LP rebalances, first-time LP mints, and swap-only execution flows safely on HyperEVM.

Network constants:
- Chain ID: `999`
- RPC: `https://rpc.hyperliquid.xyz/evm`

Core Kittenswap contracts:
- Factory: `0x5f95e92c338e6453111fc55ee66d4aafcce661a7`
- QuoterV2: `0xc58874216afe47779aded27b8aad77e8bd6ebebb`
- Router: `0x4e73e421480a7e0c24fb3c11019254ede194f736`
- NonfungiblePositionManager: `0x9ea4459c8defbf561495d95414b9cf1e2242a3e2`
- FarmingCenter: `0x211bd8917d433b7cc1f4497aba906554ab6ee479`
- AlgebraEternalFarming: `0xf3b57fe4d5d0927c3a5e549cb6af1866687e2d62`

Canonical base tokens:
- WHYPE (wrapped HYPE): `0x5555555555555555555555555555555555555555` - 18 decimals
- USD stablecoin: `0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb` - 6 decimals
- Token alias defaults in this skill context:
- `usdt`, `usdt0`, `usdc`, `usd`, `stable` -> `0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb`

Default pool deployer (standard pools):
- `0x0000000000000000000000000000000000000000`

Full token + pair CA inventory:
- `references/kittenswap-token-pair-inventory.md`
- `references/kittenswap-token-pair-inventory.json`
- Refresh command:

```bash
node skills/auto-kittenswap-lp-rebalance/scripts/refresh_kittenswap_inventory.mjs
```

## HYPE wrapping model

Native HYPE is the chain gas token and is not an ERC20. Kittenswap pools use WHYPE.

How to swap with HYPE:
- HYPE -> token: set `tokenIn = WHYPE` and add `--native-in`. Router accepts native HYPE as `msg.value`.
- Token -> HYPE: set `tokenOut = WHYPE`. Router unwraps output WHYPE to native HYPE.
- `--native-in` is valid only when `tokenIn == WHYPE`.

## Common agent flows

### Swap HYPE -> USD stablecoin (single tx, no ERC20 approval)

```bash
krlp swap-plan 0x5555555555555555555555555555555555555555 0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb --deployer 0x0000000000000000000000000000000000000000 --amount-in <HYPE_decimal_amount> <owner_address> --native-in
```

### Swap USD stablecoin -> HYPE (approval may be required)

```bash
krlp swap-plan 0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb 0x5555555555555555555555555555555555555555 --deployer 0x0000000000000000000000000000000000000000 --amount-in <USD_decimal_amount> <owner_address>
```

### Swap HYPE -> USD stablecoin with saved default account

```bash
krlp account add "main" 0xYourAddress --default
krlp swap-plan 0x5555555555555555555555555555555555555555 0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb --deployer 0x0000000000000000000000000000000000000000 --amount-in 1.5 --native-in
```

## Supported input styles

Treat these as equivalent:
- `krlp status 12345`
- `/krlp status 12345`
- `check rebalance status for 12345`

Prefer deterministic command syntax first. Use NL fallback only when command input is absent.

## Canonical commands

Health and setup:
- `health`
- `contracts`
- `account add "main" HL:0x... [--default]`
- `account list`
- `account remove "main"`
- `account default "main"`

Policy management:
- `policy list`
- `policy show [name]`
- `policy set [name] [--edge-bps N] [--slippage-bps N] [--deadline-seconds N] [--default]`

Position analysis:
- `position <tokenId> [owner|label]`
- `value|position-value <tokenId> [owner|label]`
- `status <tokenId> [--edge-bps N]`
- `wallet|portfolio [owner|label] [--active-only]`
- `quote-swap|swap-quote <tokenIn> <tokenOut> --deployer <address> --amount-in <decimal>`

Staked status detection (automatic, shown in `position`, `value`, `wallet` output):

**CRITICAL — Algebra V3 farming model (Kittenswap):**
The NFT ALWAYS stays with the original owner (EOA) when staked. `ownerOf(tokenId)` returning an EOA does NOT mean the position is unstaked. The only correct signal is `positionManager.tokenFarmedIn(tokenId)`:
- Returns zero address (`0x000...000`) → position is **NOT staked**
- Returns FarmingCenter (`0x211bd8917d433b7cc1f4497aba906554ab6ee479`) → position **IS staked** in KittenSwap FarmingCenter
- Returns any other address → position is **NOT staked in configured Kittenswap farm** (likely staked elsewhere)

For weakest-LLM-safe execution, use the canonical command:
- `krlp farm-staked-summary <owner|label> --active-only`

Canonical Kittenswap staked criteria for action gating:
- `tokenFarmedIn == FarmingCenter`
- `farmingCenter.deposits(tokenId)` incentiveId is non-zero bytes32
- If either check fails, treat as **NOT_STAKED for Kittenswap collect/exit flow**.

Output line meanings (read literally, do not infer):
- `staked status: not staked (tokenFarmedIn is zero address)` → position is NOT staked; no farm-exit steps needed
- `staked status: staked in KittenSwap FarmingCenter (0x211b...479)` → position IS staked; must exit farming before removing LP
- `staked status: not staked in configured Kittenswap farm (tokenFarmedIn points to 0x...)` → do not run Kittenswap farm-exit/collect for this token
- `staked status: inconsistent farm state (tokenFarmedIn matches farming center but deposit incentiveId is zero/invalid)` → treat as NOT_STAKED for Kittenswap actions; resolve before farming commands
- `staked status: staked status unknown (tokenFarmedIn RPC check failed)` → RPC error; do not assume either way

**Never use NFT owner address or eth_getCode to determine staking state.**

Rebalance planning:
- `plan <tokenId> [owner|label] [--recipient <address|label>] [--policy <name>] [--edge-bps N] [--width-bump-ticks N] [--slippage-bps N] [--deadline-seconds N] [--amount0 <decimal> --amount1 <decimal>] [--allow-burn] [--no-auto-compound]`
- Default rebalance continuation is no-prompt compound flow:
- exit farming and claim rewards (if staked), remove LP, swap to 50/50 notional across pair tokens (including claimed rewards), mint new position, then stake immediately.

Heartbeat orchestration:
- `heartbeat|heartbeat-plan <tokenId> [owner|label] [--recipient <address|label>] [--policy <name>] [--edge-bps N] [--width-bump-ticks N] [--slippage-bps N] [--deadline-seconds N] [--farming-center <address>] [--eternal-farming <address>]`
- Default heartbeat anti-churn threshold is `500` bps (5% edge buffer).
- Default heartbeat width policy adds `+100` ticks when rebalance is triggered.

LP mint planning:
- `mint-plan|lp-mint-plan <tokenA> <tokenB> --amount-a <decimal> --amount-b <decimal> [owner|label] [--recipient <address|label>] [--deployer <address>] [--tick-lower N --tick-upper N | --width-ticks N --center-tick N] [--policy <name>] [--slippage-bps N] [--deadline-seconds N] [--approve-max] [--allow-out-of-range] [--no-auto-stake]`
- Auto-normalize token order to token0/token1 for mint calldata.
- Enforce tick-spacing alignment and print explicit blockers for balance and allowance shortfalls.
- Tick indexes are signed int24 (negative ticks are valid). `--width-ticks N` means centered around market tick by default, not around `0`.
- Default post-mint agent action is immediate staking path (`farm-status -> farm-approve-plan -> farm-enter-plan --auto-key`) with no extra confirmation prompt.

Swap planning:
- `swap-approve-plan <token> [owner|label] --amount <decimal|max> [--spender <address>] [--approve-max]`
- `swap-plan <tokenIn> <tokenOut> --deployer <address> --amount-in <decimal> [owner|label] [--recipient <address|label>] [--policy <name>] [--slippage-bps N] [--deadline-seconds N] [--native-in] [--approve-max]`
- `swap-verify <txHash> [owner|label]`
- `mint-verify|verify-mint <txHash> [owner|label]`
- `farm-verify|verify-farm <txHash> [owner|label]`
- `tx-verify|verify-tx <txHash> [owner|label]`
- Current routing mode: single-hop `exactInputSingle`.
- Swap token aliases: `usdt/usdt0/usdc/usd/stable` map to `0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb`.

Farming/staking planning:
- `farm-status <tokenId> [owner|label] [--farming-center <address>] [--eternal-farming <address>]`
- `farm-staked-summary [owner|label] [--active-only] [--farming-center <address>] [--eternal-farming <address>]`
- `farm-approve-plan <tokenId> [owner|label] [--farming-center <address>] [--eternal-farming <address>]`
- `farm-enter-plan <tokenId> [owner|label] [--auto-key | --reward-token <address> --bonus-reward-token <address> --pool <address> --nonce <N>] [--farming-center <address>] [--eternal-farming <address>]`
- `farm-collect-plan <tokenId> [owner|label] [--auto-key | --reward-token <address> --bonus-reward-token <address> --pool <address> --nonce <N>] [--farming-center <address>] [--eternal-farming <address>]`
- `farm-claim-plan <rewardToken> [owner|label] [--to <address|label>] --amount <decimal|max> [--farming-center <address>] [--eternal-farming <address>]`
- `farm-exit-plan <tokenId> [owner|label] [--auto-key | --reward-token <address> --bonus-reward-token <address> --pool <address> --nonce <N>] [--farming-center <address>] [--eternal-farming <address>]`

Raw broadcast (optional execution handoff):
- `broadcast-raw <0xSignedTx> --yes SEND [--no-wait]`
- `swap-broadcast|swap-execute <0xSignedTx> --yes SEND [--no-wait]`

## Execution boundary

- Read on-chain state and prepare deterministic calldata.
- Never handle private keys.
- `plan` is dry-run only.
- `mint-plan` is dry-run only.
- `swap-approve-plan` and `swap-plan` are dry-run only.
- `plan` excludes burn by default; use `--allow-burn` explicitly if desired.
- `heartbeat` is dry-run orchestration only (no signing, no broadcasting).
- `farm-*` commands are dry-run only.
- `broadcast-raw` only sends already-signed transactions and requires explicit `--yes SEND`.
- Never submit dependent txs in parallel (`approve -> swap` and `approve -> mint` must be sequential).
- For `plan`, default continuation is compound-and-restake with no extra prompt (`exit/claim -> 50/50 rebalance incl. rewards -> mint -> stake`) unless `--no-auto-compound` is set.
- For successful mints, default continuation is immediate staking (`approveForFarming -> enterFarming`) without extra prompt gating unless `--no-auto-stake` is set or user explicitly asks to keep LP unstaked.

## Rebalance logic defaults

- Default edge threshold: `1500` bps (15% edge buffer)
- Default mint slippage guard: `50` bps
- Default deadline: `900` seconds
- Trigger rebalance recommendation when:
- current tick is out of range, or
- current tick is within edge buffer from lower/upper tick.

## Output rules

- Always print full addresses (no truncation).
- Always print full calldata hex for generated calls.
- Never infer or reconstruct missing address/hash characters.
- Include explicit warnings when sender differs from NFT owner.
- Mark unavailable gas estimates clearly instead of guessing.
- For swaps, print preflight sender checks (balance and allowance) and direct `eth_call` simulation result.
- For swaps, print block-safe execution checklist and require approval confirmation before dependent swap.
- For swap verify, decode `exactInputSingle` in direct calldata or nested `multicall` payloads.
- For LP mint, print token-order normalization, tick-spacing validation, position-manager allowance checks, direct `eth_call` simulation result, and range-edge drift warning.
- For LP mint, print signed-tick guidance and selected range center tick; warn when a range appears zero-anchored while market tick is far away.
- For LP mint, treat out-of-range-at-plan-time as a blocker unless explicitly overridden with `--allow-out-of-range`.
- For `value`/`wallet`, print both pair-native valuation and stable-token valuation from live `quoteExactInputSingle` marks (direct or via WHYPE bridge).
- For LP mint, approvals target `NonfungiblePositionManager` (not router).
- For LP mint, print default no-prompt post-mint staking continuation and explicit opt-out (`--no-auto-stake`).
- For rebalance `plan`, print default no-prompt compound-and-restake continuation and explicit opt-out (`--no-auto-compound`).
- For rebalance `plan`, support optional `--width-bump-ticks N` to widen replacement width deterministically.
- For heartbeat, rebalance only when out-of-range or within configured edge threshold (default 5%), and print explicit `HOLD` vs `REBALANCE_COMPOUND_RESTAKE` branch instructions.
- For heartbeat, default replacement-width policy is gradual widening (`+100` ticks per triggered rebalance) unless overridden.
- For farming enter, require position-manager `approveForFarming` preflight match with target farming center.
- For farming enter, also require ERC721 token transfer approval to farming center (`isApprovedForAll(owner,farmingCenter)` OR `getApproved(tokenId)==farmingCenter`), otherwise flag `Not approved for token` risk with exact remediation.
- For farming enter blockers, print canonical ERC721 approval calldata templates (`setApprovalForAll` and token-specific `approve(tokenId)`), with gas estimates when available.
- For farming status on active deposits, print reward-flow estimate (rate/day, reserve runway, and estimated APR from live stable mark) with explicit “estimate” labeling, and mark `PRIMARY_ONLY` mode when bonus emission rate is zero.
- For farming approval verification, detect malformed `approveForFarming` calldata shapes and report canonical selector/signature guidance.
- For swap receipts, decode `exactInputSingle` calldata and show wallet token deltas from ERC20 transfer logs.
- For failed swaps, include block-level forensic checks (pre-tx allowance/balance when available) and race-condition hints.
- For tx verification, decode approve/mint/farming calldata and surface common blockers (zero approvals, zero allowance, invalid ticks/deadline/order, signer mismatch, wrong tokenId/key for farming calldata, missing farming token transfer approval, pre-tx races, out-of-range mint at execution block).
- For LP range checks (`status`/`position`), print both side percentages (`from lower` and `to upper`) in addition to tick headroom.
- For mint failures, classify `Price slippage check` separately and print ratio/min-range mitigation guidance.
- For direct mint selector failures (`0xfe3f3be7`) with malformed calldata, print explicit canonical regeneration path via `mint-plan`/`plan`.
- For position/value/wallet output: always read and print the `staked status` field explicitly. Never infer staking from NFT owner address.
- For multi-position execution gating: use `farm-staked-summary` and only allow farm-exit/collect on rows with `statusCode = STAKED_KITTENSWAP`.

## Valuation methodology

- Wallet NFT enumeration: `balanceOf(owner)` + `tokenOfOwnerByIndex(owner, i)` on position manager.
- Per-position state: `positions(tokenId)` + pool `globalState()` + `tickSpacing()`.
- Claimable rewards: `eth_call collect(tokenId, recipient, maxUint128, maxUint128)` from wallet.
- Principal if exited now: `eth_call decreaseLiquidity(tokenId, fullLiquidity, 0, 0, deadline)` from wallet.
- No private keys are required; these are read/sim calls only.

## Bundled files

- `scripts/kittenswap_rebalance_api.mjs`: RPC + ABI helpers + call-data builders.
- `scripts/kittenswap_rebalance_chat.mjs`: command parser + dispatcher + formatted output.
- `scripts/kittenswap_rebalance_config.mjs`: local alias and policy storage.
- `scripts/refresh_kittenswap_inventory.mjs`: refresh full token and pair CA inventory from live factory logs + RPC.
- `references/rebalance-playbook.md`: operational rebalance flow and guardrails.
- `references/kittenswap-contracts-hyperevm.md`: active contract map and context.
- `references/kittenswap-token-pair-inventory.md`: full token CAs and pair/pool CAs.
- `references/kittenswap-token-pair-inventory.json`: machine-readable token and pair inventory.

## Quick manual tests

```bash
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp health"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp contracts"
node skills/auto-kittenswap-lp-rebalance/scripts/refresh_kittenswap_inventory.mjs
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp policy show"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp status 1"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp value 1"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp wallet HL:0xYourWallet..."
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp heartbeat 1 HL:0xYourWallet... --recipient HL:0xYourWallet..."
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp mint-plan HL:0xTokenA HL:0xTokenB --amount-a 0.01 --amount-b 0.30 HL:0x... --recipient HL:0x..."
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp plan 1 HL:0x... --recipient HL:0x... --width-bump-ticks 100"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp farm-status 1 HL:0x..."
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp farm-staked-summary HL:0x... --active-only"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp farm-approve-plan 1 HL:0x..."
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp farm-enter-plan 1 HL:0x... --auto-key"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp farm-collect-plan 1 HL:0x... --auto-key"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp farm-claim-plan 0x618275f8efe54c2afa87bfb9f210a52f0ff89364 HL:0x... --amount max"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp swap-quote HL:0xTokenIn HL:0xTokenOut --deployer HL:0x... --amount-in 0.01"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp swap-approve-plan HL:0xTokenIn HL:0x... --amount 0.01"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp swap-plan 0x5555555555555555555555555555555555555555 0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb --deployer 0x0000000000000000000000000000000000000000 --amount-in 1.0 HL:0xYourWallet --native-in"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp swap-plan HL:0xTokenIn HL:0xTokenOut --deployer HL:0x... --amount-in 0.01 HL:0x... --recipient HL:0x..."
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp swap-verify 0xYourTxHash..."
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp mint-verify 0xYourMintTxHash... HL:0xExpectedSigner..."
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp farm-verify 0xYourFarmTxHash..."
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp tx-verify 0xYourTxHash..."
```
