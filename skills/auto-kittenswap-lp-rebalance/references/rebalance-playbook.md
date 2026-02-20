# Rebalance Playbook

## Goal

Keep concentrated liquidity near the current market tick while controlling execution risk.

## Deterministic flow

1. Run health check:
- `krlp health`

2. Inspect position:
- `krlp position <tokenId> [owner|label]`

3. Evaluate rebalance need:
- `krlp status <tokenId> [--edge-bps N]`

4. Build execution-safe plan (dry-run):
- `krlp plan <tokenId> [owner|label] --recipient <address|label> [--amount0 X --amount1 Y]`

5. Sign transactions outside skill (wallet/custody).

6. Optional raw broadcast:
- `krlp broadcast-raw <0xSignedTx> --yes SEND`

## Safety rules

- Never execute using truncated addresses.
- Verify `from` account can operate NFT (owner or approved operator).
- Prefer test-size mint amounts first when onboarding new wallet flow.
- Use strict slippage thresholds when filling mint amounts.
- Abort if chain id does not match `999`.

## Common failure modes

- `owner != from`: sender lacks permission for position NFT operations.
- `amount0/amount1 omitted`: mint call data intentionally not generated.
- `eth_estimateGas` unavailable: calldata may still be valid, but simulation failed due permissions/balances/allowances.

## Swap flow (Kittenswap-only)

1. Quote:
- `krlp swap-quote <tokenIn> <tokenOut> --deployer <address> --amount-in <decimal>`

2. Build approval transaction (if allowance is low):
- `krlp swap-approve-plan <tokenIn> [owner|label] --amount <decimal|max>`

3. Build swap calldata plan:
- `krlp swap-plan <tokenIn> <tokenOut> --deployer <address> --amount-in <decimal> [owner|label] [--native-in]`

4. Sign transactions outside the skill.

5. Broadcast signed payload:
- `krlp broadcast-raw <0xSignedTx> --yes SEND`

Safety:
- Keep slippage conservative (`--slippage-bps`).
- Confirm pool/deployer before signing.
- Never reconstruct truncated addresses.
