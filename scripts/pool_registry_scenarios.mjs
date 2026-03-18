#!/usr/bin/env node

import process from "node:process";

import {
  DEFAULT_USD_STABLE_TOKEN,
  USDC_TOKEN_ADDRESS,
  WHYPE_TOKEN_ADDRESS,
  findInventoryPairByTokens,
  resolvePairRef,
  resolveTokenRef,
} from "../skills/auto-kittenswap-lp-rebalance/scripts/krlp_pool_registry.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const usdc = resolveTokenRef("usdc");
assert(usdc.address === USDC_TOKEN_ADDRESS, "usdc alias should resolve to real USDC");

const stable = resolveTokenRef("usdt0");
assert(stable.address === DEFAULT_USD_STABLE_TOKEN, "usdt0 alias should resolve to default USD₮0");

const hype = resolveTokenRef("hype");
assert(hype.address === WHYPE_TOKEN_ADDRESS, "hype alias should resolve to WHYPE");

const whypeUsdc = resolvePairRef("hype", "usdc");
assert(whypeUsdc.token0 === WHYPE_TOKEN_ADDRESS, "hype/usdc token0 should be WHYPE");
assert(whypeUsdc.token1 === USDC_TOKEN_ADDRESS, "hype/usdc token1 should be USDC");
assert(whypeUsdc.inventoryPair?.pool === "0x12df9913e9e08453440e3c4b1ae73819160b513e", "WHYPE/USDC pool mismatch");

const whypeStable = resolvePairRef("whype/usdt0");
assert(whypeStable.token0 === WHYPE_TOKEN_ADDRESS, "whype/usdt0 token0 should be WHYPE");
assert(whypeStable.token1 === DEFAULT_USD_STABLE_TOKEN, "whype/usdt0 token1 should be USD₮0");
assert(whypeStable.inventoryPair?.pool === "0x3c1403335d0ca7d0a73c9e775b25514537c2b809", "WHYPE/USD₮0 pool mismatch");

const pairFromInventory = findInventoryPairByTokens(WHYPE_TOKEN_ADDRESS, USDC_TOKEN_ADDRESS);
assert(pairFromInventory?.token0Symbol === "WHYPE", "inventory pair symbol token0 mismatch");
assert(pairFromInventory?.token1Symbol === "USDC", "inventory pair symbol token1 mismatch");

process.stdout.write("Pool registry scenarios passed.\n");
