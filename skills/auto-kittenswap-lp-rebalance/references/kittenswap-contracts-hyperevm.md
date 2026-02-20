# Kittenswap HyperEVM Contracts

Source baseline: Kittenswap docs (`/tokenomics/deployed-contracts`) and local on-chain snapshots.

## Active CL stack (HyperEVM mainnet)

- AlgebraFactory: `0x5f95e92c338e6453111fc55ee66d4aafcce661a7`
- QuoterV2: `0xc58874216afe47779aded27b8aad77e8bd6ebebb`
- SwapRouter: `0x4e73e421480a7e0c24fb3c11019254ede194f736`
- NonfungiblePositionManager: `0x9ea4459c8defbf561495d95414b9cf1e2242a3e2`

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
