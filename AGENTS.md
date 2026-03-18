# AGENTS.md

Start here if you're an agent working in this repo.

## Canonical sources

- Command surface: `skills/auto-kittenswap-lp-rebalance/commands.manifest.json`
- Repo-wide defaults: `policy.defaults.json`
- Main CLI: `skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs`
- Strict agent entrypoint: `skills/auto-kittenswap-lp-rebalance/scripts/krlp_agent.mjs`
- Token/pool registry: `skills/auto-kittenswap-lp-rebalance/scripts/krlp_pool_registry.mjs`
- JSON renderer/parser contract: `skills/auto-kittenswap-lp-rebalance/scripts/krlp_json_output.mjs`
- Active-token helpers: `skills/auto-kittenswap-lp-rebalance/scripts/*_active_token.mjs`
- Live contract/RPC helpers: `skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_api.mjs`

## Workflow

1. Prefer canonical command syntax over natural-language prompts.
2. For agent automation, use the strict entrypoint or pass `--strict --json`.
3. Treat `policy.defaults.json` as the single source of truth for default thresholds.
4. Resolve pool/token intent explicitly with `pool-resolve` when a pair name could be ambiguous (`usdc` vs `usd/stable`, `hype` vs WHYPE).
5. Use `--json` as the machine contract; text output is for humans.
6. Resolve active token IDs through the shared helper layer instead of carrying stale token IDs across burns/remints.
7. Never broadcast from guessed or reconstructed calldata.

## Validation

- `npm run check` — repo-safe checks, docs sync, JSON-contract scenarios, static CLI smoke
- `npm run check:runtime` — live operator self-check on a configured machine
- `npm run audit:guardrails` — live guardrail audit on a configured machine
