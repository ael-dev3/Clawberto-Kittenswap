# Clawberto Kittenswap Skills

![Kittenswap Logo](kitten-logo.webp)

Deterministic Kittenswap LP rebalance skill set for HyperEVM.

## Skill

- Path: `skills/auto-kittenswap-lp-rebalance`
- Position inspection (`owner`, `ticks`, `liquidity`, `fees owed`)
- Rebalance decisioning from live pool tick and configurable edge thresholds
- Safe calldata planning for `collect`, `decreaseLiquidity`, `burn`, and optional `mint`
- Kittenswap-only swap quoting and exact-input swap planning (`approve` + router calldata)
- Current swap route mode: single-hop (`exactInputSingle`)
- Optional raw broadcast for pre-signed transactions

## Network

- HyperEVM Mainnet
- Chain ID: `999`
- RPC: `https://rpc.hyperliquid.xyz/evm`

## Quick Start

```bash
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp health"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp contracts"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp policy show"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp status 12345"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp plan 12345 HL:0xYourWallet... --recipient HL:0xYourWallet..."
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp swap-quote HL:0xTokenIn HL:0xTokenOut --deployer HL:0x... --amount-in 0.01"
node skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs "krlp swap-plan HL:0xTokenIn HL:0xTokenOut --deployer HL:0x... --amount-in 0.01 HL:0xYourWallet... --recipient HL:0xYourWallet..."
```

## Safety Model

- Full addresses and full calldata are always printed (no truncation).
- `plan` does not sign or broadcast.
- `swap-plan` and `swap-approve-plan` do not sign or broadcast.
- Broadcasting requires a pre-signed payload and explicit `--yes SEND`.
