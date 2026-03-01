---
name: auto-kittenswap-lp-rebalance
description: Kittenswap concentrated-liquidity rebalance, heartbeat orchestration, first-time LP mint planning, and swap execution-planning skill for HyperEVM mainnet (chain id 999). Use when users need deterministic LP position inspection, range-health checks, heartbeat-triggered decisioning (`HOLD` vs `REBALANCE_COMPOUND_RESTAKE`), LP mint preflight, or swap-only flows (quote, approval plan, swap calldata plan, signed raw broadcast). Rebalance setups and LP mints are FORCE-STAKED after successful build (`approveForFarming -> enterFarming` for first mints, `exit/claim -> 50/50 rebalance incl rewards -> mint -> enterFarming` for `plan`/rebalance flows). No flag can disable this behavior. Heartbeat defaults to anti-churn edge threshold `500` bps (5%) and gradual width increase `+100` ticks on triggered rebalances. Supports `krlp ...` and `/krlp ...` commands with full-address/full-calldata output and policy/account aliases stored locally.
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
- KITTEN: `0x618275f8efe54c2afa87bfb9f210a52f0ff89364` - 18 decimals
- UETH: `0xbe6727b535545c67d5caa73dea54865b92cf7907` - 18 decimals
- Token alias defaults in this skill context:
- `usdt`, `usdt0`, `usdc`, `usd`, `stable` -> `0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb`
- `whype` -> `0x5555555555555555555555555555555555555555`
- `kitten`, `kit` -> `0x618275f8efe54c2afa87bfb9f210a52f0ff89364`
- `ueth`, `eth` -> `0xbe6727b535545c67d5caa73dea54865b92cf7907`

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

## KITTEN swap routing policy

- Default executable path is `KITTEN <-> WHYPE`.
- For `KITTEN <-> stable` intents, use deterministic two-step routing through WHYPE:
1. `KITTEN -> WHYPE`
2. `WHYPE -> stable`
- Direct KITTEN/stable one-hop pools may exist but can have insufficient live liquidity and revert.
- KITTEN route trade costs can be high; up to ~5% can be normal and should not be treated as a contract bug by itself.
- If simulation passes but execution reverts with low gas and empty reason, treat it as malformed calldata risk first (not pool-broken by default):
1. run `krlp swap-verify <txHash>`
2. check `calldata bytes` and require canonical `260` for `exactInputSingle`
3. require `limitSqrtPrice uint160 canonical check: PASS`
4. regenerate from fresh `krlp swap-plan` output and send unchanged calldata only
- Do not infer root cause from a single changed field (for example `amountOutMinimum`) when decode shape is malformed; fix calldata shape first.

## Common agent flows

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
- `withdraw 12345`

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

APR estimation:
- `apr [<tokenId>] [--pool <addr>] [--range-ticks N] [--sample-blocks N] [--hype-price P]`

Position analysis:
- `position <tokenId> [owner|label]`
- `value|position-value <tokenId> [owner|label]`
- `status <tokenId> [--edge-bps N]`
- `wallet|portfolio [owner|label] [--active-only]`
- `quote-swap|swap-quote <tokenIn> <tokenOut> --amount-in <decimal> [--deployer <address>]`

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
- `plan <tokenId> [owner|label] [--recipient <address|label>] [--policy <name>] [--edge-bps N] [--width-bump-ticks N] [--slippage-bps N] [--deadline-seconds N] [--amount0 <decimal> --amount1 <decimal>] [--allow-burn]`
- `withdraw|withdraw-plan <tokenId> [owner|label] [--recipient <address|label>] [--deadline-seconds N] [--allow-burn]`
- Default rebalance continuation is no-prompt compound flow:
- exit farming and claim rewards (if staked), remove LP, swap to 50/50 notional across pair tokens (including claimed rewards), mint new position, then stake immediately.
- `withdraw` is the canonical close-position flow (exit-only): collect fees + remove liquidity + collect owed tokens, with no auto-remint/restake.

### Rebalance user-prompt contract chain (mandatory sequence)

When the operator asks to `rebalance`, execute in this deterministic chain without extra approval prompts:

1. **Private-keyed signer context**
   - Use the configured signer key/source (`HYPEREVM_EXEC_PRIVATE_KEY` or equivalent) and sign every step in sequence.
   - No extra “authorize/confirm” step is required once the rebalance intent is explicit.

2. **Unstake (required if staked)**
   - Use `krlp farm-status` and `krlp farm-staked-summary` to confirm.
   - If `STAKED_KITTENSWAP`, run exact flow:
     - `krlp farm-exit-plan <tokenId> ... --auto-key`
     - Send `exitFarming((address rewardToken, address bonusRewardToken, address pool, uint256 nonce), uint256 tokenId)` on `0xf3b57fe4d5d0927c3a5e549cb6af1866687e2d62`.

3. **Withdraw old principal + fees**
   - `krlp withdraw <tokenId> ...`
   - Strict execution order:
     - `collect((uint256,address,uint128,uint128))`
     - `decreaseLiquidity(uint256,uint128,uint256,uint256,uint256)`
     - `collect((uint256,address,uint128,uint128))`

4. **Close old position token**
   - If close intent is explicit, execute `burn(uint256)` (`--allow-burn` path) only after the above collect/decrease/collect flow passes.

5. **Swap to 50/50 target**
   - Run `krlp swap-quote` and `krlp swap-plan` for token0 <-> token1 on WHYPE stable pair route only as needed.
   - Use the plan-generated exact `exactInputSingle(...)` calldata and execute only that payload so final notional is near-even.

6. **Build + stake replacement LP**
   - Execute `krlp plan <oldTokenId> ... --width-bump-ticks N` with explicit `--amount0/--amount1` if needed.
   - Send mint calldata with expected signature on `0x9ea4459c8defbf561495d95414b9cf1e2242a3e2`:
     - `mint(address,address,address,int24,int24,uint256,uint256,uint256,uint256,address,uint256)`
   - Then immediately stake replacement:
     - `krlp farm-approve-plan <newTokenId>`
     - `krlp farm-enter-plan <newTokenId> --auto-key`

Gate rule: never continue if any step is `BLOCKED` or any precheck is not `PASS`.

## Weak-LLM Safe Position Setup (new LP)

Use this exact sequence when user asks to `setup`, `add LP`, `open position`, or `create LP` for a token pair with no existing position replacement. Keep to the printed plan outputs only.

### Canonical sequence

1. **Confirm signer and wallet**
   - `krlp wallet <owner|label> --active-only`
   - Make sure the signer context is explicit via `<owner|label>` and matches the intended EOA owner.

2. **Plan the mint with exact amounts**
   - `krlp mint-plan <tokenA> <tokenB> --amount-a <decimal> --amount-b <decimal> <owner|label> --recipient <owner|label> [--width-ticks 400 --center-tick <tick>]`
   - Example: `krlp mint-plan 0x5555555555555555555555555555555555555555 0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb --amount-a 0.088 --amount-b 2.55 0xc979efda857823bca9a335a6c7b62a7531e1cfea --recipient 0xc979efda857823bca9a335a6c7b62a7531e1cfea`
   - Check `direct mint eth_call simulation:` and `execution gate:`.

3. **Treat blockers as hard stops**
   - If `execution gate: BLOCKED`, do **not send any tx**.
   - Remediate then rerun `mint-plan` before signing.

4. **Resolve approvals only when required**
   - If `approval required (token)` shows `YES`, run approval plans first:
     - `krlp swap-approve-plan <tokenAddress> <owner> --amount max --spender 0x9ea4459c8defbf561495d95414b9cf1e2242a3e2`
   - Re-run `mint-plan` after approvals are mined and verified.

5. **Sign and send mint tx**
   - Send the exact `mint(...)` payload from the `mint-plan` output (no edits).
   - `krlp tx-verify <txHash>` must pass and show:
     - `selector: 0xfe3f3be7`
     - decoded minted tokenId is present.

6. **Mandatory post-mint staking**
   - `krlp farm-approve-plan <newTokenId>`
   - `krlp farm-enter-plan <newTokenId> --auto-key`
   - `krlp farm-status <newTokenId>` should end as `STAKED_KITTENSWAP`.

7. **Final sanity**
   - Run `krlp wallet <owner|label> --active-only` and `krlp position <newTokenId>` for final status.

### Hard stop checks for this flow

- Never hand-edit selector/tuple/ABI payloads.
- Never start by signing/broadcasting before the `mint-plan` preflight is PASS.
- Never send stale mint payloads after long delays; rerun `mint-plan` for fresh deadlines and on-chain tick state.
- For required contract calls in this flow, use exact functions:
  - `mint` on `NonfungiblePositionManager` (selector from plan output)
  - `approveForFarming(uint256,bool,address)`
  - `enterFarming((address,address,address,uint256),uint256)`
- After each broadcast, run `krlp tx-verify <hash>` before next step.

### Useful defaults for beginners

- `--width-ticks 400`
- `--slippage-bps 50` for normal paths, increase to 100-500 only if needed
- `--deadline-seconds` typically `900`


Withdraw / close position (exit-only):
- First command for close intents: `krlp withdraw <tokenId> [owner|label]`.
- If owner is omitted and no default account exists, `withdraw` auto-falls back to on-chain `ownerOf(tokenId)` as sender.
- If output shows `staked status: staked in KittenSwap FarmingCenter (...)`, run `krlp farm-exit-plan <tokenId> [owner|label] --auto-key`, send/verify, then re-run `krlp withdraw`.
- Do not send position-manager txs unless `execution gate: PASS`.
- Step order is fixed: `collect -> decreaseLiquidity -> collect` (`-> burn` only with explicit `--allow-burn`).

Heartbeat orchestration:
- `heartbeat|heartbeat-plan <tokenId> [owner|label] [--recipient <address|label>] [--policy <name>] [--edge-bps N] [--width-bump-ticks N] [--slippage-bps N] [--deadline-seconds N] [--farming-center <address>] [--eternal-farming <address>] [--autonomous | --no-next-steps]`
- Cron/helper shortcut for live position: `heartbeat_active_token.mjs <owner|label> --recipient <owner|label> [--edge-bps N]... --autonomous --no-next-steps [--raw]`
  - Example: `node skills/auto-kittenswap-lp-rebalance/scripts/heartbeat_active_token.mjs farcaster --recipient farcaster --edge-bps 500 --autonomous --no-next-steps`
  - This helper resolves currently active NFTs first, then runs heartbeat for the latest active token (high-water mark id).
  - Default helper output is concise professional summary fields (decision/range/stake/action) for cron relays; use `--raw` for full heartbeat output.
- `heartbeat` defaults to autonomous mode in local config (`general.heartbeatAutonomous`, `general.heartbeatNoNextSteps`) and can be overridden per-call with `--no-next-steps`/`--autonomous` where needed.
- Default heartbeat anti-churn threshold is `500` bps (5% edge buffer).
- Default heartbeat width policy adds `+100` ticks when rebalance is triggered.

LP mint planning:
- `mint-plan|lp-mint-plan <tokenA> <tokenB> --amount-a <decimal> --amount-b <decimal> [owner|label] [--recipient <address|label>] [--deployer <address>] [--tick-lower N --tick-upper N | --width-ticks N --center-tick N] [--policy <name>] [--slippage-bps N] [--deadline-seconds N] [--approve-max] [--allow-out-of-range]`
- Auto-normalize token order to token0/token1 for mint calldata.
- Enforce tick-spacing alignment and print explicit blockers for balance and allowance shortfalls.
- Tick indexes are signed int24 (negative ticks are valid). `--width-ticks N` means centered around market tick by default, not around `0`.
- Default post-mint agent action is immediate staking path (`farm-status -> farm-approve-plan -> farm-enter-plan --auto-key`) with no extra confirmation prompt.

Swap planning:
- `swap-approve-plan <token> [owner|label] --amount <decimal|max> [--spender <address>] [--approve-max]`
- `swap-plan <tokenIn> <tokenOut> --amount-in <decimal> [owner|label] [--deployer <address>] [--recipient <address|label>] [--policy <name>] [--slippage-bps N] [--deadline-seconds N] [--native-in] [--approve-max]`
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
- Never embed private keys in files or outputs; execute signed txs via external signer context (`HYPEREVM_EXEC_PRIVATE_KEY` or explicit wallet signer) and keep raw keys out of logs/states.
- `plan` is dry-run only.
- `withdraw|withdraw-plan` is dry-run only.
- `mint-plan` is dry-run only.
- `swap-approve-plan` and `swap-plan` are dry-run only.
- `plan` excludes burn by default; use `--allow-burn` explicitly if desired.
- `withdraw` is exit-only and never auto-compounds/remints unless user explicitly switches to `plan`.
- `heartbeat` is dry-run orchestration only (no signing, no broadcasting).
- `farm-*` commands are dry-run only.
- `broadcast-raw` only sends already-signed transactions and requires explicit `--yes SEND`.
- Never submit dependent txs in parallel (`approve -> swap` and `approve -> mint` must be sequential).
- For `plan`, default continuation is **FORCED AUTO-STAKE** compound-and-restake with no extra prompt (`exit/claim -> 50/50 rebalance incl. rewards -> mint -> stake`); this behavior is mandatory for every rebalance entrance.
- For successful mints, continuation is immediate staking (`approveForFarming -> enterFarming`) with no extra prompt; this is mandatory for every mint entrance.

## Non-Negotiable Agent Protocol (Weak-LLM Safe)

Read and apply in order, every time:
1. Generate plan/status first (use `withdraw` for close-position intents). Never start by broadcasting a transaction.
2. If any gate prints `BLOCKED`, stop. Do not send.
3. If simulation is not `PASS` (revert/unavailable), stop. Re-run plan/status until clear.
4. Sign and send only exact calldata printed by `krlp ...-plan` outputs.
5. Never hand-edit selectors/words/hex payloads.
5a. Verify per-step selector guard in plan output before sending (`collect=0xfc6f7865`, `decrease=0x0c49ccbe`, `burn=0x42966c68`).
6. After every tx, run `krlp tx-verify <txHash>` before next step.
7. If `tx-verify` reports unknown selector on position manager with low gas, classify as calldata/ABI issue, regenerate canonical plan, and do not retry same payload.
8. Do not claim contract-level "zombie state" unless canonical remove gate (`collect+decrease`) is `BLOCKED` repeatedly with canonical calldata and owner sender.

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
- For swaps, print explicit `execution gate: BLOCKED|PASS`; if `BLOCKED`, operator must not sign/broadcast until all blockers are cleared and plan re-run.
- For `swap_exact_input_single`, print calldata byte-length guard (`260 bytes expected`) and fail-safe guidance to reject malformed payloads before signing.
- For KITTEN-involved swaps, print explicit routing guidance (`KITTEN <-> WHYPE` default, two-step via WHYPE for stable routes) and do not classify high effective trade cost (up to ~5%) as a contract bug by itself.
- For swap verify, decode `exactInputSingle` in direct calldata or nested `multicall` payloads.
- For LP mint, print token-order normalization, tick-spacing validation, position-manager allowance checks, direct `eth_call` simulation result, and range-edge drift warning.
- For LP mint, print signed-tick guidance and selected range center tick; warn when a range appears zero-anchored while market tick is far away.
- For LP mint, treat out-of-range-at-plan-time as a blocker unless explicitly overridden with `--allow-out-of-range`.
- For `value`/`wallet`, print both pair-native valuation and stable-token valuation from live `quoteExactInputSingle` marks (direct or via WHYPE bridge).
- For LP mint, approvals target `NonfungiblePositionManager` (not router).
- For LP mint, print default no-prompt post-mint staking continuation (`approveForFarming -> enterFarming`) as mandatory.
- For rebalance `plan`, print default no-prompt compound-and-restake continuation (`exit/claim -> rebalance to 50/50 -> mint -> stake`) and enforce it as mandatory.
- For rebalance `plan`, support optional `--width-bump-ticks N` to widen replacement width deterministically.
- For rebalance `plan`, print `old-position execution gate: BLOCKED|PASS`; if `BLOCKED`, operator must not send collect/decrease/burn steps.
- For rebalance `plan`, print per-step decode guards (selector/word count), decoded raw liquidity, and direct `eth_call` simulation for collect/decrease/burn templates.
- For rebalance `plan`, print phase-level lifecycle gas accounting (farm unwind, old-position withdraw, rebuild, restake projection) plus known total gas/fee and net-after-gas mark in stable units.
- For rebalance `plan`, print transparent action totals: expected old-position output amounts, stable mark, and owner-level pending reward balances/mark.
- For explicit user intent `rebalance and compound kitten`, treat it as immediate execution authorization (not planning-only) and run the full deterministic chain end-to-end unless hard-blocked.
- For this one-shot path, auto-resolve active token, claim primary KITTEN, convert claimed KITTEN into LP-side inventory, rebalance to near 50/50 notional, mint replacement, and restake replacement token.
- For one-shot path responses, return concise terminal status (new tokenId, range, in-range %, staking state, uncollected reward) instead of verbose operator instructions.
- For `withdraw`, print concise close-position sequence and explicit `execution gate: BLOCKED|PASS` before any transaction template.
- For `withdraw`, include compact fallback guidance: when runtime output is truncated/compacted, re-run `withdraw` and execute one tx at a time with `tx-verify` after each send.
- For heartbeat, rebalance only when out-of-range or within configured edge threshold (default 5%), and print explicit `HOLD` vs `REBALANCE_COMPOUND_RESTAKE` branch outcome.
- For heartbeat, always print explicit in-range state (`within range: YES|NO`) plus both side percentages (`from lower` and `to upper`) and include an explicit combined line: `range each side: lower=<pct> | upper=<pct>`.
- For heartbeat rebalance branch, always repeat trigger-position percentages in branch status: `trigger position range each side` and `trigger position min headroom`.
- For heartbeat, always print `required heartbeat action` (`NONE | REBALANCE_COMPOUND_RESTAKE | STAKE_REMEDIATION_REQUIRED`) and `stake integrity` (`PASS|FAIL`).
- For heartbeat HOLD branch, if active liquidity is present but staking state is not `STAKED_KITTENSWAP`, keep decision `HOLD` for range but explicitly flag `STAKE_REMEDIATION_REQUIRED` (never silent no-op).
- For heartbeat reward lines, report uncollected rewards via `getRewardInfo` as `pending reward now`; avoid noisy claimable labels unless explicitly requested.
- Heartbeat does not include next-step command lists when autonomous mode is active; it is now command-runner-safe for self-execution workflows.
- Local OpenClaw execution mode: when heartbeat branch is `REBALANCE_COMPOUND_RESTAKE` and signer context is available (`HYPEREVM_EXEC_PRIVATE_KEY`), agents may execute the full on-chain chain (exit/claim/withdraw/swap/mint/restake) sequentially with tx-verify gates after each step.
- For heartbeat, default replacement-width policy is gradual widening (`+100` ticks per triggered rebalance) unless overridden.
- For new-instance migration, follow `references/openclaw-instance-porting.md` and run `scripts/openclaw_instance_selfcheck.sh` before enabling cron execution.
- For farming enter, require position-manager `approveForFarming` preflight match with target farming center.
- For farming enter, also require ERC721 token transfer approval to farming center (`isApprovedForAll(owner,farmingCenter)` OR `getApproved(tokenId)==farmingCenter`), otherwise flag `Not approved for token` risk with exact remediation.
- For farming enter blockers, print canonical ERC721 approval calldata templates (`setApprovalForAll` and token-specific `approve(tokenId)`), with gas estimates when available.
- For `farm-exit-plan` and `farm-collect-plan`, print explicit `execution gate: BLOCKED|PASS`; if `BLOCKED`, operator must not sign/broadcast.
- For `farm-exit-plan`/`farm-collect-plan`, treat `tokenFarmedIn == 0x0` or zero `depositIncentiveId` as hard blockers (not warnings).
- For farming status on active deposits, print reward-flow estimate (rate/day, reserve runway, and estimated APR from live stable mark) with explicit “estimate” labeling, and mark `PRIMARY_ONLY` mode when bonus emission rate is zero.
- For farming status, print reward states explicitly: position-uncollected (`getRewardInfo`), owner-claimable (`rewards(owner,token)`), wallet token balance, with canonical flow `collectRewards -> claimReward -> wallet`.
- For farming approval verification, detect malformed `approveForFarming` calldata shapes and report canonical selector/signature guidance.
- For swap receipts, decode `exactInputSingle` calldata and show wallet token deltas from ERC20 transfer logs.
- For failed swaps, include block-level forensic checks (pre-tx allowance/balance when available), combined allowance+balance shortfall detection, and race-condition hints.
- For failed swaps with low gas + zero logs on router, print explicit early-abort guidance and canonical regeneration path via fresh `swap-plan` (no manual calldata edits).
- For tx-verify on position-manager actions, decode and validate `collect`, `decreaseLiquidity`, and `burn` calldata with token ownership/approval/state precondition checks.
- For malformed `collect`/`decreaseLiquidity`/`burn`, print exact calldata byte mismatch and partial decode context (forensic-grade guidance).
- For `collect` failures, explicitly flag zero-max (`amount0Max=0` and `amount1Max=0`) as invalid and require canonical max values.
- For low-gas unknown selector reverts on position manager, classify as ABI/calldata construction risk by default (not contract-level zombie-state evidence) and print supported canonical selectors.
- For tx verification, decode approve/mint/farming calldata and surface common blockers (zero approvals, zero allowance, invalid ticks/deadline/order, signer mismatch, wrong tokenId/key for farming calldata, missing farming token transfer approval, pre-tx races, out-of-range mint at execution block).
- For `position`/`status`, print canonical remove readiness (`collect` + `decreaseLiquidity` sim gate) so weak LLMs can distinguish removable positions from call-construction mistakes.
- For LP range checks (`status`/`position`), print both side percentages (`from lower` and `to upper`) in addition to tick headroom.
- For mint failures, classify `Price slippage check` separately and print ratio/min-range mitigation guidance.
- Proven fallback: if default slippage (50 bps) blocks mint simulation during rebalance, regenerate the same mint plan with `--slippage-bps 500` and use only refreshed calldata.
- For direct mint selector failures (`0xfe3f3be7`) with malformed calldata, print explicit canonical regeneration path via `mint-plan`/`plan`.
- For position/value/wallet output: always read and print the `staked status` field explicitly. Never infer staking from NFT owner address.
- For multi-position execution gating: use `farm-staked-summary` and only allow farm-exit/collect on rows with `statusCode = STAKED_KITTENSWAP`.
- For APR output, use on-chain `Swap` log sampling from the pool address (not UI backfill constants) and print sampling window confidence (swap count, pages scanned, truncated flag).
- For APR output, treat out-of-range position APR as `0` until range re-entry; do not report positive APR on out-of-range positions.

## Session-Learned LLM Prompts (today)

Use this exact command order for recurring checks:

1. Active LP posture / movement room:
- `krlp wallet [owner|label] --active-only`
- For each active `tokenId`: `krlp status <tokenId> [owner|label]`
- Interpret headroom as:
  - `tickHeadroom` and side percentages (`from lower`, `to upper`) directly from output.

2. Pending rewards + reward velocity (uncollected-aware):
- `krlp farm-status <tokenId> [owner|label]`
- `krlp farm-staked-summary [owner|label] --active-only`
- Use `farm-status` reward states to avoid false-zero confusion:
  - position-uncollected (`getRewardInfo`)
  - owner-claimable (`rewards(owner,token)`)
  - wallet balance (`balanceOf(owner)`)
- For accumulation proof, run `farm-status` twice 20-40s apart and compare uncollected deltas.

3. APR checks:
- `krlp apr [tokenId] --pool <poolAddress> --range-ticks <N> --sample-blocks <M>`
- For one token, include in-range status before claiming huge APR.

4. Staked state enforcement:
- If any mint/rebalance is requested, always continue to:
  - `krlp farm-status <newTokenId>`
  - `krlp farm-approve-plan <newTokenId>`
  - `krlp farm-enter-plan <newTokenId> --auto-key`
  - auto-stake is mandatory by policy.

5. Reward claiming:
- `krlp farm-collect-plan <tokenId> [owner|label] --auto-key`
- `krlp farm-claim-plan <rewardToken> [owner|label] --amount max`

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
- `scripts/openclaw_instance_selfcheck.sh`: local OpenClaw instance readiness check (binaries, chain id, signer env, health/heartbeat dry-run).
- `scripts/heartbeat_contract_smoke.sh`: heartbeat output-contract smoke test (summary + raw modes, required fields).
- `references/rebalance-playbook.md`: operational rebalance flow and guardrails.
- `references/openclaw-instance-porting.md`: portability checklist for migrating this automation to a new OpenClaw instance.
- `references/kittenswap-contracts-hyperevm.md`: active contract map and context.
- `references/kittenswap-token-pair-inventory.md`: full token CAs and pair/pool CAs.
- `references/kittenswap-token-pair-inventory.json`: machine-readable token and pair inventory.

## Quick manual tests

```bash
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp health"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp contracts"
bash skills/auto-kittenswap-lp-rebalance/scripts/openclaw_instance_selfcheck.sh farcaster
bash skills/auto-kittenswap-lp-rebalance/scripts/heartbeat_contract_smoke.sh farcaster farcaster 500
node skills/auto-kittenswap-lp-rebalance/scripts/refresh_kittenswap_inventory.mjs
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp policy show"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp status 1"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp value 1"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp wallet HL:0xYourWallet..."
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp heartbeat 1 HL:0xYourWallet... --recipient HL:0xYourWallet..."
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp mint-plan HL:0xTokenA HL:0xTokenB --amount-a 0.01 --amount-b 0.30 HL:0x... --recipient HL:0x..."
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp withdraw 1 HL:0x... --recipient HL:0x..."
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
