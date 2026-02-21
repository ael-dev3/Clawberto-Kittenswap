# Kittenswap HyperEVM Contracts

Source baseline:
- Kittenswap docs (`/tokenomics/deployed-contracts`)
- Live on-chain reads from HyperEVM RPC
- Live factory log scan from Hyperscan Blockscout API v2

## Core CL stack (HyperEVM mainnet)

- AlgebraFactory: `0x5f95e92c338e6453111fc55ee66d4aafcce661a7`
- QuoterV2: `0xc58874216afe47779aded27b8aad77e8bd6ebebb`
- SwapRouter: `0x4e73e421480a7e0c24fb3c11019254ede194f736`
- NonfungiblePositionManager: `0x9ea4459c8defbf561495d95414b9cf1e2242a3e2`

Default pool deployer (standard factory pools):
- `0x0000000000000000000000000000000000000000`

## Canonical swap base token CAs

- WHYPE (Wrapped HYPE): `0x5555555555555555555555555555555555555555` (18 decimals)
- USD stablecoin: `0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb` (6 decimals)

Use `--native-in` only when `tokenIn == WHYPE`.

## Full token + pair CA inventory

Generated files:
- `references/kittenswap-token-pair-inventory.md`
- `references/kittenswap-token-pair-inventory.json`

Generation method:
- Enumerate factory-emitted `Pool` and `CustomPool` events from:
  - `https://www.hyperscan.com/api/v2/addresses/<factory>/logs`
- Resolve token metadata via live ERC20 calls (`symbol`, `name`, `decimals`).
- Resolve pool metadata via live calls (`tickSpacing`, `globalState().tick`).

Refresh command:

```bash
node skills/auto-kittenswap-lp-rebalance/scripts/refresh_kittenswap_inventory.mjs
```

## Function surfaces used by this skill

Position manager:
- `ownerOf(uint256)`
- `positions(uint256)`
- `collect((uint256,address,uint128,uint128))`
- `decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))`
- `burn(uint256)`
- `mint((address,address,address,int24,int24,uint256,uint256,uint256,uint256,address,uint256))`

Factory:
- `poolByPair(address,address)`

Pool:
- `globalState()`
- `tickSpacing()`

QuoterV2:
- `quoteExactInputSingle((address,address,address,uint256,uint160))`

SwapRouter:
- `exactInputSingle((address,address,address,address,uint256,uint256,uint256,uint160))`
- `WNativeToken()`

ERC-20:
- `symbol()`
- `name()`
- `decimals()`
- `balanceOf(address)`
- `allowance(address,address)`
- `approve(address,uint256)`

## Explorer links

- Hyperscan: `https://www.hyperscan.com`
- Purrsec: `https://purrsec.com`
