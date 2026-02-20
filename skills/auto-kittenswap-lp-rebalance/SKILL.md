---
name: auto-kittenswap-lp-rebalance
description: Kittenswap concentrated-liquidity rebalance and swap execution-planning skill for HyperEVM mainnet (chain id 999). Use when users need deterministic LP position inspection, range-health checks, rebalance decisioning, or swap-only flows (quote, approval plan, swap calldata plan, signed raw broadcast). Supports `krlp ...` and `/krlp ...` commands with full-address/full-calldata output and policy/account aliases stored locally.
---

# Auto Kittenswap LP Rebalance

Inspect and plan Kittenswap LP rebalances and swap-only execution flows safely on HyperEVM.

Network constants:
- Chain ID: `999`
- RPC: `https://rpc.hyperliquid.xyz/evm`

Core Kittenswap contracts:
- Factory: `0x5f95e92c338e6453111fc55ee66d4aafcce661a7`
- QuoterV2: `0xc58874216afe47779aded27b8aad77e8bd6ebebb`
- Router: `0x4e73e421480a7e0c24fb3c11019254ede194f736`
- NonfungiblePositionManager: `0x9ea4459c8defbf561495d95414b9cf1e2242a3e2`

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

Rebalance planning:
- `plan <tokenId> [owner|label] [--recipient <address|label>] [--policy <name>] [--edge-bps N] [--slippage-bps N] [--deadline-seconds N] [--amount0 <decimal> --amount1 <decimal>]`

Swap planning:
- `swap-approve-plan <token> [owner|label] --amount <decimal|max> [--spender <address>] [--approve-max]`
- `swap-plan <tokenIn> <tokenOut> --deployer <address> --amount-in <decimal> [owner|label] [--recipient <address|label>] [--policy <name>] [--slippage-bps N] [--deadline-seconds N] [--native-in] [--approve-max]`
- Current routing mode: single-hop `exactInputSingle` only.
- These commands support swap-only operation with no LP rebalance steps required.

Raw broadcast (optional execution handoff):
- `broadcast-raw <0xSignedTx> --yes SEND [--no-wait]`
- `swap-broadcast|swap-execute <0xSignedTx> --yes SEND [--no-wait]`

## Execution boundary

- This skill reads on-chain state and prepares deterministic calldata.
- This skill does not handle private keys.
- `plan` is dry-run only.
- `swap-approve-plan` and `swap-plan` are dry-run only.
- `broadcast-raw` only sends already signed transactions and requires explicit `--yes SEND`.

## Rebalance logic defaults

- Default edge threshold: `1500` bps (15% edge buffer).
- Default slippage basis points for mint min amounts: `50` bps.
- Default deadline: `900` seconds.
- Rebalance recommendation triggers when:
- current tick is out of range, or
- current tick is within edge buffer from lower/upper tick.

## Output rules

- Always print full addresses (no truncation).
- Always print full calldata hex for generated calls.
- Never infer or reconstruct missing address/hash characters.
- Include explicit warnings when sender differs from NFT owner.
- Mark unavailable gas estimates clearly instead of guessing.
- For swaps, print preflight sender checks (balance/allowance) and direct `eth_call` simulation result.

## Valuation methodology

- Wallet NFT enumeration: `balanceOf(owner)` + `tokenOfOwnerByIndex(owner, i)` on position manager.
- Per-position state: `positions(tokenId)` + pool `globalState()` + `tickSpacing()`.
- Claimable rewards: `eth_call collect(tokenId, recipient, maxUint128, maxUint128)` from the wallet.
- Principal if exited now: `eth_call decreaseLiquidity(tokenId, fullLiquidity, 0, 0, deadline)` from the wallet.
- No private keys required; these are read/sim calls only.

## Bundled files

- `scripts/kittenswap_rebalance_api.mjs`: RPC + ABI helpers + call-data builders.
- `scripts/kittenswap_rebalance_chat.mjs`: command parser + dispatcher + formatted output.
- `scripts/kittenswap_rebalance_config.mjs`: local alias/policy storage.
- `references/rebalance-playbook.md`: operational rebalance flow and guardrails.
- `references/kittenswap-contracts-hyperevm.md`: active contract map and context.

## Quick manual tests

```bash
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp health"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp contracts"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp policy show"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp status 1"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp value 1"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp wallet HL:0xYourWallet..."
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp plan 1 HL:0x... --recipient HL:0x..."
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp swap-quote HL:0xTokenIn HL:0xTokenOut --deployer HL:0x... --amount-in 0.01"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp swap-approve-plan HL:0xTokenIn HL:0x... --amount 0.01"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp swap-plan HL:0xTokenIn HL:0xTokenOut --deployer HL:0x... --amount-in 0.01 HL:0x... --recipient HL:0x..."
```
