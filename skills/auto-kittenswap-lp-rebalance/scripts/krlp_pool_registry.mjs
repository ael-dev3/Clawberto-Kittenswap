import { readFileSync } from "node:fs";

import { assertAddress, normalizeAddress } from "./kittenswap_rebalance_api.mjs";

const INVENTORY_URL = new URL("../references/kittenswap-token-pair-inventory.json", import.meta.url);

export const WHYPE_TOKEN_ADDRESS = "0x5555555555555555555555555555555555555555";
export const DEFAULT_USD_STABLE_TOKEN = "0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb";
export const USDC_TOKEN_ADDRESS = "0xb88339cb7199b77e23db6e890353e22632ba630f";
export const KITTEN_TOKEN_ADDRESS = "0x618275f8efe54c2afa87bfb9f210a52f0ff89364";
export const UETH_TOKEN_ADDRESS = "0xbe6727b535545c67d5caa73dea54865b92cf7907";

export const TOKEN_ALIAS_HELP = Object.freeze([
  { aliases: ["hype", "whype"], address: WHYPE_TOKEN_ADDRESS, note: "Kittenswap pool token is WHYPE" },
  { aliases: ["usdc"], address: USDC_TOKEN_ADDRESS, note: "real USDC token" },
  { aliases: ["usdt", "usdt0", "usd", "stable", "stablecoin"], address: DEFAULT_USD_STABLE_TOKEN, note: "default stable token (USD₮0)" },
  { aliases: ["kit", "kitten"], address: KITTEN_TOKEN_ADDRESS, note: "KITTEN token" },
  { aliases: ["eth", "ueth"], address: UETH_TOKEN_ADDRESS, note: "UETH token" },
]);

export const TOKEN_ALIAS_MAP = Object.freeze(new Map(
  TOKEN_ALIAS_HELP.flatMap((entry) => entry.aliases.map((alias) => [alias, entry.address])),
));

const INVENTORY = Object.freeze(JSON.parse(readFileSync(INVENTORY_URL, "utf8")));

function normalizeAliasKey(input) {
  return String(input || "")
    .normalize("NFKD")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function canonicalPairKey(tokenA, tokenB) {
  const a = assertAddress(tokenA);
  const b = assertAddress(tokenB);
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function buildIndexes() {
  const tokensByAddress = new Map();
  const symbolCandidates = new Map();
  for (const token of INVENTORY.tokens || []) {
    const address = normalizeAddress(token?.address || "");
    if (!address) continue;
    tokensByAddress.set(address, token);
    const symbolKey = normalizeAliasKey(token?.symbol || "");
    if (!symbolKey) continue;
    const list = symbolCandidates.get(symbolKey) || [];
    list.push(token);
    symbolCandidates.set(symbolKey, list);
  }

  const uniqueSymbolToToken = new Map();
  const ambiguousSymbols = new Map();
  for (const [symbolKey, tokens] of symbolCandidates.entries()) {
    const uniqueAddresses = [...new Set(tokens.map((token) => normalizeAddress(token.address)).filter(Boolean))];
    if (uniqueAddresses.length === 1) {
      uniqueSymbolToToken.set(symbolKey, tokens[0]);
    } else if (uniqueAddresses.length > 1) {
      ambiguousSymbols.set(symbolKey, tokens);
    }
  }

  const pairsByKey = new Map();
  const pairsByPool = new Map();
  for (const pair of INVENTORY.pairs || []) {
    const token0 = normalizeAddress(pair?.token0 || "");
    const token1 = normalizeAddress(pair?.token1 || "");
    const pool = normalizeAddress(pair?.pool || "");
    if (!token0 || !token1) continue;
    const key = canonicalPairKey(token0, token1);
    const list = pairsByKey.get(key) || [];
    list.push(pair);
    pairsByKey.set(key, list);
    if (pool) pairsByPool.set(pool, pair);
  }

  return Object.freeze({
    tokensByAddress,
    uniqueSymbolToToken,
    ambiguousSymbols,
    pairsByKey,
    pairsByPool,
  });
}

const INDEXES = buildIndexes();

function preferredPairRank(pair) {
  const eventType = String(pair?.eventType || "");
  if (eventType === "Pool") return 0;
  if (eventType === "CustomPool") return 1;
  return 2;
}

function selectPreferredPair(candidates = []) {
  if (!Array.isArray(candidates) || !candidates.length) return null;
  return [...candidates].sort((left, right) => {
    const rankDelta = preferredPairRank(left) - preferredPairRank(right);
    if (rankDelta !== 0) return rankDelta;
    const leftBlock = Number(left?.blockNumber || 0);
    const rightBlock = Number(right?.blockNumber || 0);
    if (leftBlock !== rightBlock) return rightBlock - leftBlock;
    return String(left?.pool || "").localeCompare(String(right?.pool || ""));
  })[0];
}

export function tokenMetaForAddress(address) {
  const normalized = normalizeAddress(address || "");
  return normalized ? INDEXES.tokensByAddress.get(normalized) || null : null;
}

export function findInventoryPairByTokens(tokenA, tokenB) {
  const key = canonicalPairKey(tokenA, tokenB);
  return selectPreferredPair(INDEXES.pairsByKey.get(key) || []);
}

export function findInventoryPairByPool(poolAddress) {
  const normalized = normalizeAddress(poolAddress || "");
  return normalized ? INDEXES.pairsByPool.get(normalized) || null : null;
}

function formatAmbiguousCandidates(tokens = []) {
  return tokens
    .map((token) => `${token.symbol || "TOKEN"}:${normalizeAddress(token.address) || token.address}`)
    .join(", ");
}

function tokenAliasError(field) {
  const aliases = TOKEN_ALIAS_HELP
    .map((entry) => `${entry.aliases.join("/")} => ${entry.address}`)
    .join("; ");
  return `Use full token address, an unambiguous inventory symbol, or a known alias (${aliases}).`;
}

export function resolveTokenRef(ref, { field = "token" } = {}) {
  const raw = String(ref || "").trim();
  const asAddress = normalizeAddress(raw);
  if (asAddress) {
    return {
      address: assertAddress(raw),
      source: "address",
      input: raw,
      aliasKey: null,
      meta: tokenMetaForAddress(raw),
    };
  }

  const aliasKey = normalizeAliasKey(raw);
  if (!aliasKey) throw new Error(`Invalid ${field}: ${ref}. ${tokenAliasError(field)}`);

  if (TOKEN_ALIAS_MAP.has(aliasKey)) {
    const address = TOKEN_ALIAS_MAP.get(aliasKey);
    return {
      address,
      source: "manual_alias",
      input: raw,
      aliasKey,
      meta: tokenMetaForAddress(address),
    };
  }

  if (INDEXES.uniqueSymbolToToken.has(aliasKey)) {
    const token = INDEXES.uniqueSymbolToToken.get(aliasKey);
    return {
      address: assertAddress(token.address),
      source: "inventory_symbol",
      input: raw,
      aliasKey,
      meta: token,
    };
  }

  if (INDEXES.ambiguousSymbols.has(aliasKey)) {
    const matches = INDEXES.ambiguousSymbols.get(aliasKey);
    throw new Error(
      `Ambiguous ${field}: ${ref}. Inventory matches: ${formatAmbiguousCandidates(matches)}. Use a full token address instead.`,
    );
  }

  throw new Error(`Invalid ${field}: ${ref}. ${tokenAliasError(field)}`);
}

function sortResolvedTokens(left, right) {
  if (left.address === right.address) throw new Error("tokenA and tokenB must differ");
  if (left.address < right.address) {
    return {
      tokenA: left.address,
      tokenB: right.address,
      token0: left.address,
      token1: right.address,
      tokenAInfo: left,
      tokenBInfo: right,
      token0Info: left,
      token1Info: right,
      inputAIsToken0: true,
    };
  }
  return {
    tokenA: left.address,
    tokenB: right.address,
    token0: right.address,
    token1: left.address,
    tokenAInfo: left,
    tokenBInfo: right,
    token0Info: right,
    token1Info: left,
    inputAIsToken0: false,
  };
}

export function resolvePairRef(pairOrTokenARef, tokenBRef = null, { field = "pair" } = {}) {
  const pairRaw = String(pairOrTokenARef || "").trim();
  if (!tokenBRef && normalizeAddress(pairRaw)) {
    const inventoryPair = findInventoryPairByPool(pairRaw);
    if (!inventoryPair) {
      return {
        mode: "pool",
        poolAddress: assertAddress(pairRaw),
        inventoryPair: null,
      };
    }
    const sorted = sortResolvedTokens(
      resolveTokenRef(inventoryPair.token0, { field: `${field}.token0` }),
      resolveTokenRef(inventoryPair.token1, { field: `${field}.token1` }),
    );
    return {
      mode: "pool",
      poolAddress: assertAddress(pairRaw),
      inventoryPair,
      ...sorted,
    };
  }

  if (!tokenBRef && pairRaw.includes("/")) {
    const [leftRaw, rightRaw, extra] = pairRaw.split("/");
    if (!leftRaw || !rightRaw || extra != null) {
      throw new Error(`Invalid ${field}: ${pairOrTokenARef}. Use <tokenA>/<tokenB> or separate token refs.`);
    }
    tokenBRef = rightRaw;
    pairOrTokenARef = leftRaw;
  }

  if (!pairOrTokenARef || !tokenBRef) {
    throw new Error(`Invalid ${field}. Use <tokenA> <tokenB>, <tokenA>/<tokenB>, or a pool address.`);
  }

  const left = resolveTokenRef(pairOrTokenARef, { field: `${field}.tokenA` });
  const right = resolveTokenRef(tokenBRef, { field: `${field}.tokenB` });
  const sorted = sortResolvedTokens(left, right);
  return {
    mode: "pair",
    inventoryPair: findInventoryPairByTokens(sorted.token0, sorted.token1),
    ...sorted,
  };
}

export function describeResolvedToken(tokenRef) {
  if (!tokenRef) return "unknown";
  const symbol = tokenRef.meta?.symbol || "TOKEN";
  if (tokenRef.source === "manual_alias") {
    return `${symbol} (${tokenRef.address}) via alias "${tokenRef.input}"`;
  }
  if (tokenRef.source === "inventory_symbol") {
    return `${symbol} (${tokenRef.address}) via inventory symbol "${tokenRef.input}"`;
  }
  return `${symbol} (${tokenRef.address})`;
}

export { INVENTORY };
