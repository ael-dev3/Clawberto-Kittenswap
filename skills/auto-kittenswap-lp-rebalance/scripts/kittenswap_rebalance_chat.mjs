#!/usr/bin/env node
// Command + NL interface for Kittenswap LP rebalance planning on HyperEVM.

import { readFile } from "node:fs/promises";

import {
  DEFAULT_CHAIN_ID,
  DEFAULT_RPC_URL,
  KITTENSWAP_CONTRACTS,
  normalizeAddress,
  assertAddress,
  assertTxHash,
  txLink,
  addressLink,
  rpcCall,
  rpcChainId,
  rpcBlockNumber,
  rpcGetBlockByNumber,
  rpcGasPrice,
  rpcSendRawTransaction,
  waitForReceipt,
  receiptStatus,
  readOwnerOf,
  readPositionManagerTokenApproval,
  readPositionManagerIsApprovedForAll,
  readPositionManagerFarmingCenter,
  readPositionFarmingApproval,
  readTokenFarmedIn,
  readPosition,
  readPoolAddressByPair,
  readEternalFarmingIncentiveKey,
  readEternalFarmingIncentive,
  readFarmingCenterDeposit,
  readEternalFarmingRewardBalance,
  readEternalVirtualPoolRewardState,
  readPoolGlobalState,
  readPoolTickSpacing,
  readErc20Symbol,
  readErc20Name,
  readErc20Decimals,
  readErc20Balance,
  readErc20Allowance,
  listOwnedTokenIds,
  quoteExactInputSingle,
  simulateCollect,
  simulateDecreaseLiquidity,
  parseTokenId,
  parseDecimalToUnits,
  formatUnits,
  parseBps,
  parseSeconds,
  evaluateRebalanceNeed,
  suggestCenteredRange,
  alignTickDown,
  alignTickNearest,
  tickToPrice,
  buildCollectCalldata,
  buildDecreaseLiquidityCalldata,
  buildBurnCalldata,
  buildMintCalldata,
  buildApproveCalldata,
  buildSetApprovalForAllCalldata,
  buildApproveForFarmingCalldata,
  buildFarmingEnterCalldata,
  buildFarmingExitCalldata,
  buildFarmingCollectRewardsCalldata,
  buildFarmingClaimRewardCalldata,
  hashIncentiveKey,
  buildSwapExactInputSingleCalldata,
  estimateCallGas,
  toHexQuantity,
  maxUint128,
  readRouterWNativeToken,
  rpcGetNativeBalance,
} from "./kittenswap_rebalance_api.mjs";

import {
  loadConfig,
  setAccountAlias,
  removeAccountAlias,
  setDefaultAccount,
  resolveAccountRef,
  getPolicy,
  listPolicies,
  upsertPolicy,
} from "./kittenswap_rebalance_config.mjs";

const INVENTORY_JSON_URL = new URL("../references/kittenswap-token-pair-inventory.json", import.meta.url);

function stripPrefix(raw) {
  const t = raw.trim();
  const lower = t.toLowerCase();
  const prefixes = ["/krlp", "krlp", "/kitreb", "kitreb"];
  for (const p of prefixes) {
    if (lower === p) return "";
    if (lower.startsWith(`${p} `)) return t.slice(p.length).trim();
  }
  return null;
}

function tokenize(s) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const m of s.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3]);
  return out.filter(Boolean);
}

function parseArgs(tokens) {
  const args = { _: [] };
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.startsWith("--")) {
      const key = tok.slice(2);
      const next = tokens[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(tok);
    }
  }
  return args;
}

function fmtNum(x, { dp = 4 } = {}) {
  const n = Number(x);
  if (!Number.isFinite(n)) return String(x ?? "n/a");
  return n.toLocaleString(undefined, { maximumFractionDigits: dp, minimumFractionDigits: 0 });
}

function fmtPct(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return "n/a";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function parseBoolFlag(v) {
  if (typeof v === "boolean") return v;
  const s = String(v ?? "").toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

function maxUint256() {
  return (1n << 256n) - 1n;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_BYTES32 = `0x${"0".repeat(64)}`;
const WHYPE_TOKEN_ADDRESS = "0x5555555555555555555555555555555555555555";
const DEFAULT_USD_STABLE_TOKEN = "0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb";
const MIN_ALGEBRA_TICK = -887272;
const MAX_ALGEBRA_TICK = 887272;
const MAX_PLAN_STALENESS_BLOCKS = 40;
const MIN_DEPENDENCY_CONFIRMATIONS = 1;
const HYPERSCAN_API_V2 = process.env.HYPERSCAN_API_V2 || "https://www.hyperscan.com/api/v2";
const AUTO_KEY_NONCE_SCAN_LIMIT = (() => {
  const raw = Number(process.env.KRLP_AUTO_KEY_NONCE_SCAN_LIMIT || 64);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 64;
})();
const AUTO_KEY_NONCE_FORWARD_SCAN_LIMIT = (() => {
  const raw = Number(process.env.KRLP_AUTO_KEY_NONCE_FORWARD_SCAN_LIMIT || 8);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 8;
})();
const AUTO_KEY_HISTORY_SCAN_PAGES = (() => {
  const raw = Number(process.env.KRLP_AUTO_KEY_HISTORY_SCAN_PAGES || 8);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 8;
})();

const TOKEN_ALIAS_MAP = new Map([
  ["usd", DEFAULT_USD_STABLE_TOKEN],
  ["usdc", DEFAULT_USD_STABLE_TOKEN],
  ["usdt", DEFAULT_USD_STABLE_TOKEN],
  ["usdt0", DEFAULT_USD_STABLE_TOKEN],
  ["stable", DEFAULT_USD_STABLE_TOKEN],
  ["stablecoin", DEFAULT_USD_STABLE_TOKEN],
]);

function hasFarmingTokenTransferApproval({ tokenApproval, operatorApproved, farmingCenter }) {
  if (operatorApproved === true) return true;
  return tokenApproval === farmingCenter;
}

function includesInsensitive(value, needle) {
  return String(value || "").toLowerCase().includes(String(needle || "").toLowerCase());
}

function formatRatePerSecond(rawRate, decimals, symbol) {
  if (rawRate == null) return "n/a";
  return `${formatUnits(rawRate, decimals, { precision: 8 })} ${symbol}/s`;
}

function formatRatePerDay(rawRate, decimals, symbol) {
  if (rawRate == null) return "n/a";
  const perDay = rawRate * 86_400n;
  return `${formatUnits(perDay, decimals, { precision: 8 })} ${symbol}/day`;
}

function formatDurationSeconds(secondsRaw) {
  const sec = Number(secondsRaw);
  if (!Number.isFinite(sec) || sec < 0) return "n/a";
  const days = sec / 86400;
  if (days >= 1) return `${fmtNum(days, { dp: 2 })} days`;
  const hours = sec / 3600;
  if (hours >= 1) return `${fmtNum(hours, { dp: 2 })} hours`;
  return `${fmtNum(sec, { dp: 0 })} sec`;
}

function isMeaningfulBigInt(value) {
  return typeof value === "bigint" && value > 0n;
}

function createStableQuoteContext({ stableToken = DEFAULT_USD_STABLE_TOKEN, deployer = ZERO_ADDRESS } = {}) {
  return {
    stableToken: assertAddress(stableToken),
    deployer: assertAddress(deployer),
    tokenMetaCache: new Map(),
    quoteCache: new Map(),
  };
}

function maybeBlockTagFromNumber(blockNumber) {
  const n = Number(blockNumber);
  if (!Number.isFinite(n) || n < 0) return null;
  return toHexQuantity(BigInt(Math.floor(n)));
}

function queryString(params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === "") continue;
    qs.set(k, String(v));
  }
  const out = qs.toString();
  return out ? `?${out}` : "";
}

async function fetchJsonWithRetry(url, { tries = 3, baseDelayMs = 250 } = {}) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { method: "GET", headers: { Accept: "application/json" } });
      const txt = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${txt.slice(0, 240)}`);
      return txt ? JSON.parse(txt) : null;
    } catch (err) {
      lastErr = err;
      if (i >= tries - 1) break;
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** i));
    }
  }
  throw lastErr || new Error(`Failed to fetch ${url}`);
}

async function inferRouterApprovalAfterFailedSwap({ ownerAddress, failedBlock, lookAheadBlocks = 120, maxPages = 3 } = {}) {
  const owner = normalizeAddress(ownerAddress);
  if (!owner || !Number.isFinite(Number(failedBlock))) return null;

  let next = null;
  for (let page = 0; page < maxPages; page++) {
    const url = `${HYPERSCAN_API_V2}/addresses/${owner}/transactions${queryString(next || {})}`;
    const res = await fetchJsonWithRetry(url).catch(() => null);
    const items = Array.isArray(res?.items) ? res.items : [];
    for (const tx of items) {
      const block = Number(tx?.block_number || 0);
      if (!Number.isFinite(block) || block <= 0) continue;
      if (block < failedBlock - 4) return null;
      if (block <= failedBlock || block > failedBlock + lookAheadBlocks) continue;
      const method = String(tx?.method || "").toLowerCase();
      if (method !== "approve" && method !== "0x095ea7b3") continue;
      const hash = String(tx?.hash || "").toLowerCase();
      if (!/^0x[0-9a-f]{64}$/.test(hash)) continue;
      const detail = await fetchJsonWithRetry(`${HYPERSCAN_API_V2}/transactions/${hash}`).catch(() => null);
      const params = Array.isArray(detail?.decoded_input?.parameters) ? detail.decoded_input.parameters : [];
      const spenderParam = params.find((p) => {
        const n = String(p?.name || "").toLowerCase();
        return n === "spender" || n === "guy";
      });
      const spender = normalizeAddress(spenderParam?.value || "");
      if (spender === KITTENSWAP_CONTRACTS.router) {
        return { approvalTxHash: hash, approvalBlock: block };
      }
    }
    if (!res?.next_page_params) break;
    next = res.next_page_params;
  }
  return null;
}

async function inferFarmingKeyFromExplorerHistory({
  ownerAddress,
  tokenId,
  poolAddress = null,
  farmingCenterAddress = KITTENSWAP_CONTRACTS.farmingCenter,
  maxPages = AUTO_KEY_HISTORY_SCAN_PAGES,
} = {}) {
  const owner = normalizeAddress(ownerAddress);
  const farmingCenter = normalizeAddress(farmingCenterAddress);
  const pool = poolAddress ? normalizeAddress(poolAddress) : null;
  if (!owner || !farmingCenter) return null;
  if (tokenId == null) return null;

  const selectors = [
    { selector: "0x5739f0b9", method: "enterFarming" },
    { selector: "0x6af00aee", method: "collectRewards" },
    { selector: "0x4473eca6", method: "exitFarming" },
  ];

  let next = null;
  for (let page = 0; page < maxPages; page++) {
    const url = `${HYPERSCAN_API_V2}/addresses/${owner}/transactions${queryString(next || {})}`;
    const res = await fetchJsonWithRetry(url).catch(() => null);
    const items = Array.isArray(res?.items) ? res.items : [];
    for (const tx of items) {
      const to = normalizeAddress(tx?.to?.hash || tx?.to || "");
      if (to !== farmingCenter) continue;
      const rawInput = String(tx?.raw_input || tx?.input || "").toLowerCase();
      if (!rawInput.startsWith("0x")) continue;
      for (const candidate of selectors) {
        if (!rawInput.startsWith(candidate.selector)) continue;
        const decoded = decodeFarmingActionInput(rawInput, candidate.selector);
        if (!decoded) continue;
        if (decoded.tokenId !== tokenId) continue;
        if (pool && decoded.pool !== pool) continue;
        return {
          key: normalizeIncentiveKey({
            rewardToken: decoded.rewardToken,
            bonusRewardToken: decoded.bonusRewardToken,
            pool: decoded.pool,
            nonce: decoded.nonce,
          }),
          source: `history:${candidate.method}`,
          sourceTxHash: String(tx?.hash || "").toLowerCase() || null,
        };
      }
    }
    if (!res?.next_page_params) break;
    next = res.next_page_params;
  }
  return null;
}

function parseOptionalUint(input, fallback = 0n) {
  if (input == null || String(input).trim() === "") return fallback;
  const s = String(input).trim();
  const n = s.startsWith("0x") || s.startsWith("0X") ? BigInt(s) : BigInt(s.replace(/_/g, ""));
  if (n < 0n) throw new Error(`Expected non-negative integer, got: ${input}`);
  return n;
}

function parseInteger(input, { field = "value", min = null, max = null } = {}) {
  const s = String(input ?? "").trim();
  if (!/^-?\d+$/.test(s)) throw new Error(`Invalid ${field}: ${input}`);
  const n = Number.parseInt(s, 10);
  if (!Number.isFinite(n)) throw new Error(`Invalid ${field}: ${input}`);
  if (min != null && n < min) throw new Error(`${field} must be >= ${min}`);
  if (max != null && n > max) throw new Error(`${field} must be <= ${max}`);
  return n;
}

function parseOptionalInteger(input, fallback = null, opts = {}) {
  if (input == null || String(input).trim() === "") return fallback;
  return parseInteger(input, opts);
}

function normalizeTokenAliasKey(input) {
  return String(input || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function resolveTokenAddressInput(ref, { field = "token" } = {}) {
  const raw = String(ref || "").trim();
  const addr = extractAddress(raw);
  if (addr) return assertAddress(raw);

  const aliasKey = normalizeTokenAliasKey(raw);
  const aliased = TOKEN_ALIAS_MAP.get(aliasKey);
  if (aliased) return aliased;

  throw new Error(`Invalid ${field}: ${ref}. Use full token address or alias (usdt/usdt0/usdc/usd/stable).`);
}

function sortTokenPair(tokenARef, tokenBRef) {
  const tokenA = assertAddress(tokenARef);
  const tokenB = assertAddress(tokenBRef);
  if (tokenA === tokenB) throw new Error("tokenA and tokenB must differ");
  if (tokenA < tokenB) {
    return { tokenA, tokenB, token0: tokenA, token1: tokenB, inputAIsToken0: true };
  }
  return { tokenA, tokenB, token0: tokenB, token1: tokenA, inputAIsToken0: false };
}

function isTickAligned(tick, tickSpacing) {
  const spacing = Math.abs(Number(tickSpacing || 1));
  if (!Number.isFinite(spacing) || spacing < 1) return false;
  return tick % spacing === 0;
}

function extractAddress(text) {
  return normalizeAddress(text);
}

async function resolveAddressInput(ref, { allowDefault = true } = {}) {
  if (extractAddress(ref)) return assertAddress(ref);
  const resolved = await resolveAccountRef(ref ?? "");
  if (resolved.address) return resolved.address;
  if (!allowDefault && !String(ref ?? "").trim()) {
    throw new Error("Missing address input.");
  }
  if (resolved.source === "missing") {
    throw new Error('No address provided and no default account set. Add one with: krlp account add "main" HL:0x... --default');
  }
  throw new Error(`Unknown saved account: ${resolved.label ?? ref}`);
}

async function readTokenSnapshot(tokenAddress, ownerAddress = null) {
  const address = assertAddress(tokenAddress);
  const [symbol, name, decimals, balance] = await Promise.all([
    readErc20Symbol(address).catch(() => "TOKEN"),
    readErc20Name(address).catch(() => "Token"),
    readErc20Decimals(address).catch(() => 18),
    ownerAddress ? readErc20Balance(address, ownerAddress).catch(() => null) : Promise.resolve(null),
  ]);
  return { address, symbol, name, decimals, balance };
}

async function loadPositionContext(tokenId, { ownerAddress = null } = {}) {
  const [nftOwner, pos] = await Promise.all([
    withRpcRetry(() => readOwnerOf(tokenId, { positionManager: KITTENSWAP_CONTRACTS.positionManager })),
    withRpcRetry(() => readPosition(tokenId, { positionManager: KITTENSWAP_CONTRACTS.positionManager })),
  ]);

  const poolAddress = await withRpcRetry(() => readPoolAddressByPair(pos.token0, pos.token1, { factory: KITTENSWAP_CONTRACTS.factory }));
  if (!poolAddress) {
    throw new Error(`No pool found for pair ${pos.token0} / ${pos.token1}`);
  }

  const [poolState, tickSpacing, token0, token1] = await Promise.all([
    withRpcRetry(() => readPoolGlobalState(poolAddress)),
    withRpcRetry(() => readPoolTickSpacing(poolAddress)),
    withRpcRetry(() => readTokenSnapshot(pos.token0, ownerAddress)),
    withRpcRetry(() => readTokenSnapshot(pos.token1, ownerAddress)),
  ]);

  const price1Per0 = tickToPrice(poolState.tick, { decimals0: token0.decimals, decimals1: token1.decimals });
  const price0Per1 = price1Per0 && price1Per0 !== 0 ? 1 / price1Per0 : null;

  return {
    tokenId: parseTokenId(tokenId),
    nftOwner,
    position: pos,
    poolAddress,
    poolState,
    tickSpacing,
    token0,
    token1,
    price1Per0,
    price0Per1,
  };
}

function formatTokenLine(token, { includeBalance = false } = {}) {
  const lines = [];
  lines.push(`- ${token.symbol} (${token.name})`);
  lines.push(`  - address: ${token.address}`);
  lines.push(`  - decimals: ${token.decimals}`);
  if (includeBalance && token.balance != null) {
    lines.push(`  - balance: ${formatUnits(token.balance, token.decimals, { precision: 8 })} ${token.symbol}`);
  }
  return lines.join("\n");
}

function priceSection(ctx) {
  const lines = [];
  lines.push("- price snapshot (from pool tick):");
  lines.push(`  - tick: ${ctx.poolState.tick}`);
  lines.push(`  - token1/token0: ${ctx.price1Per0 == null ? "n/a" : fmtNum(ctx.price1Per0, { dp: 8 })}`);
  lines.push(`  - token0/token1: ${ctx.price0Per1 == null ? "n/a" : fmtNum(ctx.price0Per1, { dp: 8 })}`);
  return lines.join("\n");
}

function rangeHeadroomPct(current, lower, upper) {
  const width = upper - lower;
  if (!Number.isFinite(width) || width <= 0) return null;
  const near = Math.min(current - lower, upper - current);
  return (near / width) * 100;
}

function rangeSidePercents(current, lower, upper) {
  const width = upper - lower;
  if (!Number.isFinite(width) || width <= 0) {
    return {
      fromLowerPct: null,
      toUpperPct: null,
    };
  }
  return {
    fromLowerPct: ((current - lower) / width) * 100,
    toUpperPct: ((upper - current) / width) * 100,
  };
}

function pushCommandFlag(parts, flag, value) {
  if (value == null || value === "") return;
  parts.push(`--${flag}`, String(value));
}

function renderCommand(parts) {
  return parts
    .map((x) => String(x ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

function parseNonNegativeIntegerOrDefault(value, fallback, label) {
  if (value == null || value === "") return Number(fallback);
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid ${label}: ${value}`);
  return Math.floor(n);
}

function computeCenteredRangeWithWidthBump({
  currentTick,
  tickLower,
  tickUpper,
  tickSpacing,
  widthBumpTicks = 0,
}) {
  const spacing = Math.max(1, Math.abs(Number(tickSpacing || 1)));
  const baseWidth = Number(tickUpper) - Number(tickLower);
  if (!Number.isFinite(baseWidth) || baseWidth <= 0) {
    throw new Error(`Invalid tick range width: [${tickLower}, ${tickUpper}]`);
  }

  const bumpRequested = parseNonNegativeIntegerOrDefault(widthBumpTicks, 0, "width-bump-ticks");
  const bumpApplied = bumpRequested > 0 ? Math.ceil(bumpRequested / spacing) * spacing : 0;
  const targetWidth = baseWidth + bumpApplied;

  const seedLower = Number(currentTick) - Math.floor(targetWidth / 2);
  const seedUpper = seedLower + targetWidth;
  const rec = suggestCenteredRange({
    currentTick,
    oldLower: seedLower,
    oldUpper: seedUpper,
    tickSpacing,
  });

  return {
    rec,
    baseWidth,
    bumpRequested,
    bumpApplied,
    targetWidth: rec.widthTicks,
  };
}

function describeRewardMode({
  hasBonusRewardToken,
  bonusRewardEmissionActive,
  bonusRewardEmissionKnownZero,
}) {
  if (!hasBonusRewardToken) {
    return {
      code: "PRIMARY_ONLY",
      detail: "no secondary reward token configured",
    };
  }
  if (bonusRewardEmissionActive) {
    return {
      code: "DUAL_REWARD",
      detail: "primary and secondary emissions are active",
    };
  }
  if (bonusRewardEmissionKnownZero) {
    return {
      code: "PRIMARY_ONLY",
      detail: "primary reward path active",
    };
  }
  return {
    code: "PRIMARY_ONLY",
    detail: "primary reward path active (secondary status unavailable)",
  };
}

function isPriceSlippageRevert(input) {
  return /price slippage check/i.test(String(input || ""));
}

function analyzeDeadlineVsBlock(deadlineRaw, blockTs) {
  if (typeof deadlineRaw !== "bigint" || blockTs == null) return null;
  const looksMillis = deadlineRaw > 10_000_000_000n;
  const onchainPass = deadlineRaw > BigInt(blockTs);
  const rendered = `${deadlineRaw.toString()} vs ${blockTs}`;
  if (looksMillis) {
    const blockMs = BigInt(blockTs) * 1000n;
    const msPass = deadlineRaw > blockMs;
    return {
      pass: onchainPass,
      rendered,
      unitHint: `milliseconds-like value detected; ms interpretation would be ${msPass ? "PASS" : "FAIL"} (${deadlineRaw.toString()}ms vs ${blockMs.toString()}ms)`,
    };
  }
  return {
    pass: onchainPass,
    rendered,
    unitHint: null,
  };
}

function nearestRangeEdgeTicks(currentTick, tickLower, tickUpper) {
  if (!Number.isFinite(currentTick) || !Number.isFinite(tickLower) || !Number.isFinite(tickUpper)) return null;
  return Math.min(currentTick - tickLower, tickUpper - currentTick);
}

function centerTickOfRange(tickLower, tickUpper, spacing = 1) {
  if (!Number.isFinite(tickLower) || !Number.isFinite(tickUpper) || tickUpper <= tickLower) return null;
  const midpoint = tickLower + Math.floor((tickUpper - tickLower) / 2);
  return alignTickNearest(midpoint, Math.max(1, Number(spacing || 1)));
}

function likelyZeroAnchoredRange({ currentTick, tickLower, tickUpper, spacing }) {
  const center = centerTickOfRange(tickLower, tickUpper, spacing);
  const width = tickUpper - tickLower;
  if (!Number.isFinite(currentTick) || center == null || !Number.isFinite(width) || width <= 0) return false;
  const nearZeroCenter = Math.abs(center) <= Math.max(20, Math.max(1, Number(spacing || 1)) * 4);
  const farFromMarket = Math.abs(currentTick - center) >= Math.max(2000, width * 4);
  return nearZeroCenter && farFromMarket;
}

function buildBalanceRebalanceHint(ctx, ownerAddress) {
  if (!ownerAddress || ctx.token0.balance == null || ctx.token1.balance == null || ctx.price1Per0 == null) return null;

  const amount0 = Number(formatUnits(ctx.token0.balance, ctx.token0.decimals, { precision: 12 }));
  const amount1 = Number(formatUnits(ctx.token1.balance, ctx.token1.decimals, { precision: 12 }));
  if (!Number.isFinite(amount0) || !Number.isFinite(amount1)) return null;

  // Value everything in token1 units.
  const value0In1 = amount0 * ctx.price1Per0;
  const totalValueIn1 = value0In1 + amount1;
  if (!Number.isFinite(totalValueIn1) || totalValueIn1 <= 0) return null;
  const targetHalf = totalValueIn1 / 2;

  if (value0In1 > targetHalf) {
    const excess0 = (value0In1 - targetHalf) / ctx.price1Per0;
    return {
      side: "sell_token0",
      tokenIn: ctx.token0.symbol,
      tokenOut: ctx.token1.symbol,
      amountIn: excess0,
      explanation: `Wallet is overweight ${ctx.token0.symbol}; consider swapping ~${fmtNum(excess0, { dp: 6 })} ${ctx.token0.symbol} into ${ctx.token1.symbol} before mint.`,
    };
  }

  const excess1 = targetHalf - value0In1;
  return {
    side: "sell_token1",
    tokenIn: ctx.token1.symbol,
    tokenOut: ctx.token0.symbol,
    amountIn: excess1,
    explanation: `Wallet is overweight ${ctx.token1.symbol}; consider swapping ~${fmtNum(excess1, { dp: 6 })} ${ctx.token1.symbol} into ${ctx.token0.symbol} before mint.`,
  };
}

async function resolveFarmingContracts({ farmingCenterRef = "", eternalFarmingRef = "" } = {}) {
  const farmingCenter = farmingCenterRef ? await resolveAddressInput(farmingCenterRef, { allowDefault: false }) : KITTENSWAP_CONTRACTS.farmingCenter;
  const eternalFarming = eternalFarmingRef
    ? await resolveAddressInput(eternalFarmingRef, { allowDefault: false })
    : KITTENSWAP_CONTRACTS.eternalFarming;
  const managerFarmingCenter = await withRpcRetry(() => readPositionManagerFarmingCenter({
    positionManager: KITTENSWAP_CONTRACTS.positionManager,
  })).catch(() => null);

  return { farmingCenter, eternalFarming, managerFarmingCenter };
}

function normalizeIncentiveKey(input) {
  if (!input || typeof input !== "object") throw new Error("Missing incentive key.");
  return {
    rewardToken: assertAddress(input.rewardToken),
    bonusRewardToken: assertAddress(input.bonusRewardToken),
    pool: assertAddress(input.pool),
    nonce: parseOptionalUint(input.nonce, 0n),
  };
}

async function resolveIncentiveKey({
  tokenId = null,
  rewardTokenRef = "",
  bonusRewardTokenRef = "",
  poolRef = "",
  nonceRef = "",
  autoKey = false,
  matchDepositIncentive = false,
  ownerAddress = null,
  farmingCenterAddress = KITTENSWAP_CONTRACTS.farmingCenter,
  eternalFarmingAddress = KITTENSWAP_CONTRACTS.eternalFarming,
} = {}) {
  if (!autoKey) {
    if (!rewardTokenRef || !bonusRewardTokenRef || !poolRef || String(nonceRef).trim() === "") {
      throw new Error("Provide full incentive key (--reward-token --bonus-reward-token --pool --nonce) or use --auto-key.");
    }
    return {
      key: normalizeIncentiveKey({
        rewardToken: rewardTokenRef,
        bonusRewardToken: bonusRewardTokenRef,
        pool: poolRef,
        nonce: nonceRef,
      }),
      source: "manual",
      resolvedPool: assertAddress(poolRef),
    };
  }

  let pool = null;
  if (poolRef) {
    pool = await resolveAddressInput(poolRef, { allowDefault: false });
  } else if (tokenId != null) {
    const position = await withRpcRetry(() => readPosition(tokenId, { positionManager: KITTENSWAP_CONTRACTS.positionManager }));
    pool = await withRpcRetry(() => readPoolAddressByPair(position.token0, position.token1, { factory: KITTENSWAP_CONTRACTS.factory }));
    if (!pool) throw new Error(`No pool found for tokenId ${tokenId.toString()} pair on factory.`);
  } else {
    throw new Error("Auto-key needs --pool or tokenId context.");
  }

  const activeKeyRaw = await withRpcRetry(() => readEternalFarmingIncentiveKey(pool, { eternalFarming: eternalFarmingAddress }));
  if (activeKeyRaw.pool === ZERO_ADDRESS || activeKeyRaw.rewardToken === ZERO_ADDRESS) {
    throw new Error(`No active incentive key found for pool ${pool}.`);
  }
  const activeKey = normalizeIncentiveKey(activeKeyRaw);

  const keyHashFor = async (keyToHash) => {
    try {
      return await withRpcRetry(() => hashIncentiveKey(keyToHash));
    } catch {
      return null;
    }
  };

  if (!matchDepositIncentive || tokenId == null) {
    return {
      key: activeKey,
      source: "auto:active-pool-key",
      resolvedPool: pool,
    };
  }

  const depositIncentiveId = await withRpcRetry(
    () => readFarmingCenterDeposit(tokenId, { farmingCenter: farmingCenterAddress })
  ).catch(() => null);
  const depositId = String(depositIncentiveId || "").toLowerCase();
  const hasDepositId = /^0x[0-9a-f]{64}$/.test(depositId) && depositId !== ZERO_BYTES32;

  if (!hasDepositId) {
    return {
      key: activeKey,
      source: "auto:active-pool-key(no-deposit)",
      resolvedPool: pool,
      depositIncentiveId: depositIncentiveId || null,
      keyIncentiveId: null,
      keyMatchesDeposit: null,
    };
  }

  const activeKeyIncentiveId = await keyHashFor(activeKey);
  if (activeKeyIncentiveId && activeKeyIncentiveId === depositId) {
    return {
      key: activeKey,
      source: "auto:deposit-match(active-key)",
      resolvedPool: pool,
      depositIncentiveId: depositId,
      keyIncentiveId: activeKeyIncentiveId,
      keyMatchesDeposit: true,
      sourceTxHash: null,
    };
  }

  const historyResolved = ownerAddress
    ? await inferFarmingKeyFromExplorerHistory({
      ownerAddress,
      tokenId,
      poolAddress: pool,
      farmingCenterAddress,
      maxPages: AUTO_KEY_HISTORY_SCAN_PAGES,
    }).catch(() => null)
    : null;
  if (historyResolved?.key) {
    const historyKeyIncentiveId = await keyHashFor(historyResolved.key);
    return {
      key: historyResolved.key,
      source: `auto:${historyResolved.source}`,
      resolvedPool: pool,
      depositIncentiveId: depositId,
      keyIncentiveId: historyKeyIncentiveId,
      keyMatchesDeposit: historyKeyIncentiveId ? historyKeyIncentiveId === depositId : null,
      sourceTxHash: historyResolved.sourceTxHash || null,
    };
  }

  const scanLimit = Math.max(0, Math.floor(AUTO_KEY_NONCE_SCAN_LIMIT));
  const forwardScanLimit = Math.max(0, Math.floor(AUTO_KEY_NONCE_FORWARD_SCAN_LIMIT));
  const nonceFloor = activeKey.nonce > BigInt(scanLimit) ? activeKey.nonce - BigInt(scanLimit) : 0n;
  for (let nonce = activeKey.nonce; nonce >= nonceFloor; nonce -= 1n) {
    if (nonce === activeKey.nonce) {
      if (nonce === 0n) break;
      continue;
    }
    const candidate = { ...activeKey, nonce };
    // eslint-disable-next-line no-await-in-loop
    const candidateId = await keyHashFor(candidate);
    if (candidateId && candidateId === depositId) {
      return {
        key: candidate,
        source: "auto:deposit-match(nonce-scan)",
        resolvedPool: pool,
        depositIncentiveId: depositId,
        keyIncentiveId: candidateId,
        keyMatchesDeposit: true,
        sourceTxHash: null,
      };
    }
    if (nonce === 0n) break;
  }

  for (let delta = 1; delta <= forwardScanLimit; delta++) {
    const nonce = activeKey.nonce + BigInt(delta);
    const candidate = { ...activeKey, nonce };
    // eslint-disable-next-line no-await-in-loop
    const candidateId = await keyHashFor(candidate);
    if (candidateId && candidateId === depositId) {
      return {
        key: candidate,
        source: "auto:deposit-match(forward-scan)",
        resolvedPool: pool,
        depositIncentiveId: depositId,
        keyIncentiveId: candidateId,
        keyMatchesDeposit: true,
        sourceTxHash: null,
      };
    }
  }

  throw new Error(
    `Unable to resolve deposit incentive key for tokenId ${tokenId.toString()} on pool ${pool}. ` +
    `Deposit incentiveId ${depositId} does not match active key nonce ${activeKey.nonce.toString()}, ` +
    `no matching history key was found for owner ${ownerAddress || "n/a"}, and nonce scan window ` +
    `(back=${scanLimit}, forward=${forwardScanLimit}) did not match.`
  );
}

function isRetryableRpcError(err) {
  const msg = String(err?.message || err || "");
  return /rate limit|too many requests|\b429\b|timeout|abort|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(msg);
}

// Classify staked status by calling tokenFarmedIn(tokenId) on the position manager.
//
// IMPORTANT: In Algebra V3 (Kittenswap), the NFT always stays with the original owner (EOA).
// The NFT owner address is NOT transferred to the FarmingCenter when staking.
// Canonical Kittenswap staking action gate:
//   - tokenFarmedIn(tokenId) must equal configured FarmingCenter
//   - farmingCenter.deposits(tokenId) incentiveId must be non-zero bytes32
// If either check fails, treat as NOT staked for Kittenswap collect/exit workflows.
//
// DO NOT use ownerOf() or eth_getCode() to determine staking — the NFT owner is always an EOA.
//
// Returns: { staked: boolean|null, farmedIn: string|null, label: string }
// staked=true  → canonical Kittenswap checks passed
// staked=false → not staked in configured Kittenswap farm (or inconsistent farm state)
// staked=null  → RPC call failed; staking state is unknown
async function classifyStakedStatus(tokenId) {
  try {
    const farmedIn = await readTokenFarmedIn(tokenId, { positionManager: KITTENSWAP_CONTRACTS.positionManager });
    if (!farmedIn || farmedIn === ZERO_ADDRESS) {
      return { staked: false, farmedIn: null, label: "not staked (tokenFarmedIn is zero address)" };
    }
    if (farmedIn.toLowerCase() !== KITTENSWAP_CONTRACTS.farmingCenter.toLowerCase()) {
      return {
        staked: false,
        farmedIn,
        label: `not staked in configured Kittenswap farm (tokenFarmedIn points to ${farmedIn})`,
      };
    }
    const depositIncentiveId = await readFarmingCenterDeposit(tokenId, {
      farmingCenter: KITTENSWAP_CONTRACTS.farmingCenter,
    }).catch(() => null);
    if (!hasNonZeroBytes32(depositIncentiveId)) {
      return {
        staked: false,
        farmedIn,
        label: "inconsistent farm state (tokenFarmedIn matches farming center but deposit incentiveId is zero/invalid)",
      };
    }
    return { staked: true, farmedIn, label: `staked in KittenSwap FarmingCenter (${farmedIn})` };
  } catch {
    return { staked: null, farmedIn: null, label: "staked status unknown (tokenFarmedIn RPC check failed)" };
  }
}

function hasNonZeroBytes32(value) {
  const s = String(value || "").toLowerCase();
  return /^0x[0-9a-f]{64}$/.test(s) && s !== ZERO_BYTES32;
}

function classifyKittenswapFarmStakeState({
  tokenFarmedIn,
  farmingCenter,
  depositIncentiveId,
} = {}) {
  const farmedIn = normalizeAddress(tokenFarmedIn || "");
  const center = normalizeAddress(farmingCenter || KITTENSWAP_CONTRACTS.farmingCenter);
  const hasDeposit = hasNonZeroBytes32(depositIncentiveId);

  if (!farmedIn || farmedIn === ZERO_ADDRESS) {
    return {
      stakedInKittenswap: false,
      stakedElsewhere: false,
      statusCode: "NOT_STAKED",
      reason: "tokenFarmedIn is zero address",
    };
  }

  if (!center || farmedIn !== center) {
    return {
      stakedInKittenswap: false,
      stakedElsewhere: true,
      statusCode: "STAKED_OTHER_CONTRACT",
      reason: `tokenFarmedIn points to ${farmedIn}, not configured farming center`,
    };
  }

  if (!hasDeposit) {
    return {
      stakedInKittenswap: false,
      stakedElsewhere: false,
      statusCode: "INCONSISTENT_FARM_STATE",
      reason: "tokenFarmedIn matches farming center but deposit incentiveId is zero/invalid",
    };
  }

  return {
    stakedInKittenswap: true,
    stakedElsewhere: false,
    statusCode: "STAKED_KITTENSWAP",
    reason: "tokenFarmedIn matches farming center and deposit incentiveId is set",
  };
}

function strip0x(hex) {
  return String(hex ?? "").replace(/^0x/i, "");
}

function hexWord(wordsHex, index) {
  const start = index * 64;
  return wordsHex.slice(start, start + 64);
}

function decodeErrorStringFromRevertData(dataHex) {
  const body = strip0x(dataHex);
  if (body.length < 8 + 64 * 2) return null;
  const selector = body.slice(0, 8).toLowerCase();
  if (selector !== "08c379a0") return null;
  const words = body.slice(8);
  try {
    const offset = Number(BigInt(`0x${hexWord(words, 0)}`));
    if (!Number.isFinite(offset) || offset < 0 || offset % 32 !== 0) return null;
    const startWord = offset / 32;
    const lenWord = hexWord(words, startWord);
    if (!lenWord) return null;
    const len = Number(BigInt(`0x${lenWord}`));
    if (!Number.isFinite(len) || len < 0) return null;
    const bytesStart = (startWord + 1) * 64;
    const bytesEnd = bytesStart + len * 2;
    const payload = words.slice(bytesStart, bytesEnd);
    if (payload.length !== len * 2) return null;
    return Buffer.from(payload, "hex").toString("utf8").replace(/\0+$/g, "").trim() || null;
  } catch {
    return null;
  }
}

function decodePanicFromRevertData(dataHex) {
  const body = strip0x(dataHex);
  if (body.length < 8 + 64) return null;
  const selector = body.slice(0, 8).toLowerCase();
  if (selector !== "4e487b71") return null;
  const words = body.slice(8);
  try {
    const code = BigInt(`0x${hexWord(words, 0)}`);
    const codeHex = `0x${code.toString(16)}`;
    const known = new Map([
      [0x01n, "assert(false)"],
      [0x11n, "arithmetic overflow/underflow"],
      [0x12n, "division or modulo by zero"],
      [0x21n, "enum conversion out of bounds"],
      [0x22n, "invalid storage byte array access"],
      [0x31n, "pop() on empty array"],
      [0x32n, "array index out of bounds"],
      [0x41n, "memory allocation overflow"],
      [0x51n, "zero-initialized function pointer call"],
    ]);
    return known.has(code) ? `panic ${codeHex} (${known.get(code)})` : `panic ${codeHex}`;
  } catch {
    return null;
  }
}

function parseRpcErrorPayload(err) {
  const msg = String(err?.message || err || "").trim();
  const objects = [];
  if (err && typeof err === "object") objects.push(err);

  const prefixed = msg.match(/^RPC error:\s*(\{[\s\S]*\})$/i);
  if (prefixed) {
    try {
      objects.push(JSON.parse(prefixed[1]));
    } catch {
      // ignore parse failures; raw text fallback still applies
    }
  }

  const generic = msg.match(/(\{[\s\S]*\})/);
  if (generic) {
    try {
      objects.push(JSON.parse(generic[1]));
    } catch {
      // ignore
    }
  }
  return objects;
}

function collectPotentialRevertData(value, out = []) {
  if (value == null) return out;
  if (typeof value === "string") {
    const s = value.trim();
    if (/^0x[0-9a-fA-F]+$/.test(s) && s.length >= 10) out.push(s);
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectPotentialRevertData(v, out);
    return out;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k.toLowerCase().includes("data") || k.toLowerCase().includes("error") || k.toLowerCase().includes("result")) {
        collectPotentialRevertData(v, out);
      } else if (typeof v === "object") {
        collectPotentialRevertData(v, out);
      }
    }
  }
  return out;
}

function decodeRevertDataHint(dataHex) {
  const reason = decodeErrorStringFromRevertData(dataHex);
  if (reason) return reason;
  const panic = decodePanicFromRevertData(dataHex);
  if (panic) return panic;
  return null;
}

async function withRpcRetry(fn, { tries = 5, baseDelayMs = 250 } = {}) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryableRpcError(err) || i === tries - 1) throw err;
      const waitMs = baseDelayMs * 2 ** i;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw lastErr || new Error("RPC call failed");
}

function unitsToNumber(raw, decimals, { precision = 18 } = {}) {
  if (typeof raw !== "bigint") return null;
  const txt = formatUnits(raw, decimals, { precision });
  const n = Number(txt);
  return Number.isFinite(n) ? n : null;
}

function estimateValueInToken1({ amount0 = null, amount1 = null, price1Per0 = null } = {}) {
  if (!Number.isFinite(amount0) || !Number.isFinite(amount1) || !Number.isFinite(price1Per0)) return null;
  return amount1 + amount0 * price1Per0;
}

async function readTokenMetaCached(tokenAddress, { cache = null } = {}) {
  const addr = assertAddress(tokenAddress);
  if (cache && cache.has(addr)) return cache.get(addr);
  const meta = await readTokenSnapshot(addr).catch(() => null);
  if (cache && meta) cache.set(addr, meta);
  return meta;
}

async function quoteExactInputSingleCached(
  { tokenIn, tokenOut, deployer = ZERO_ADDRESS, amountIn },
  { cache = null } = {}
) {
  const aIn = typeof amountIn === "bigint" ? amountIn : BigInt(String(amountIn || "0"));
  if (aIn <= 0n) return { ok: true, amountOut: 0n, quote: null };
  const key = `${assertAddress(tokenIn)}|${assertAddress(tokenOut)}|${assertAddress(deployer)}|${aIn.toString()}`;
  if (cache && cache.has(key)) return cache.get(key);
  const out = await withRpcRetry(() => quoteExactInputSingle({
    tokenIn,
    tokenOut,
    deployer,
    amountIn: aIn,
    limitSqrtPrice: 0n,
  })).then((q) => ({ ok: true, amountOut: q.amountOut, quote: q }))
    .catch((e) => ({ ok: false, amountOut: null, quote: null, error: e?.message || String(e) }));
  if (cache) cache.set(key, out);
  return out;
}

async function quoteTokenAmountToStable(
  tokenAddress,
  amountRaw,
  {
    stableQuoteCtx = null,
  } = {}
) {
  const ctx = stableQuoteCtx || createStableQuoteContext();
  const tokenIn = assertAddress(tokenAddress);
  const stableToken = ctx.stableToken;
  const deployer = ctx.deployer;
  const amountIn = typeof amountRaw === "bigint" ? amountRaw : BigInt(String(amountRaw ?? "0"));
  const stableMeta = await readTokenMetaCached(stableToken, { cache: ctx.tokenMetaCache });

  if (amountIn <= 0n) {
    return {
      ok: true,
      route: "none",
      amountOutRaw: 0n,
      amountOut: 0,
      stableToken,
      stableMeta,
      errors: [],
    };
  }

  if (tokenIn === stableToken) {
    return {
      ok: true,
      route: "identity",
      amountOutRaw: amountIn,
      amountOut: unitsToNumber(amountIn, stableMeta?.decimals ?? 6),
      stableToken,
      stableMeta,
      errors: [],
    };
  }

  const direct = await quoteExactInputSingleCached({
    tokenIn,
    tokenOut: stableToken,
    deployer,
    amountIn,
  }, { cache: ctx.quoteCache });
  if (direct.ok && isMeaningfulBigInt(direct.amountOut)) {
    return {
      ok: true,
      route: "direct",
      amountOutRaw: direct.amountOut,
      amountOut: unitsToNumber(direct.amountOut, stableMeta?.decimals ?? 6),
      stableToken,
      stableMeta,
      errors: [],
    };
  }

  const errors = [];
  if (!direct.ok && direct.error) errors.push(`direct quote failed: ${direct.error}`);

  const bridge = WHYPE_TOKEN_ADDRESS;
  if (tokenIn !== bridge && stableToken !== bridge) {
    const step1 = await quoteExactInputSingleCached({
      tokenIn,
      tokenOut: bridge,
      deployer,
      amountIn,
    }, { cache: ctx.quoteCache });
    if (step1.ok && isMeaningfulBigInt(step1.amountOut)) {
      const step2 = await quoteExactInputSingleCached({
        tokenIn: bridge,
        tokenOut: stableToken,
        deployer,
        amountIn: step1.amountOut,
      }, { cache: ctx.quoteCache });
      if (step2.ok && isMeaningfulBigInt(step2.amountOut)) {
        return {
          ok: true,
          route: "via_whype",
          amountOutRaw: step2.amountOut,
          amountOut: unitsToNumber(step2.amountOut, stableMeta?.decimals ?? 6),
          stableToken,
          stableMeta,
          viaWhypeAmountRaw: step1.amountOut,
          errors,
        };
      }
      if (!step2.ok && step2.error) errors.push(`bridge step2 failed: ${step2.error}`);
    } else if (!step1.ok && step1.error) {
      errors.push(`bridge step1 failed: ${step1.error}`);
    }
  }

  return {
    ok: false,
    route: "unavailable",
    amountOutRaw: null,
    amountOut: null,
    stableToken,
    stableMeta,
    errors,
  };
}

function extractRevertHint(err) {
  const msg = String(err?.message || err || "");
  const direct = msg.match(/execution reverted(?::\s*revert:)?\s*([^",}]+)/i);
  if (direct && direct[1]) return direct[1].trim();

  const payloads = parseRpcErrorPayload(err);
  for (const payload of payloads) {
    const dataCandidates = collectPotentialRevertData(payload);
    for (const data of dataCandidates) {
      const decoded = decodeRevertDataHint(data);
      if (decoded) return decoded;
    }
    const hinted = JSON.stringify(payload).match(/execution reverted(?::\s*revert:)?\s*([^",}]+)/i);
    if (hinted && hinted[1]) return hinted[1].trim();
  }

  if (/\bSTF\b/.test(msg)) return "STF (ERC20 transferFrom failed)";
  const bare = msg.match(/execution reverted/i);
  return bare ? "execution reverted (no reason provided)" : null;
}

function classifyCallFailure(err) {
  const revertHint = extractRevertHint(err);
  if (isRetryableRpcError(err)) {
    return {
      category: "rpc_unavailable",
      revertHint,
    };
  }
  if (revertHint) {
    return {
      category: "revert",
      revertHint,
    };
  }
  return {
    category: "unknown_error",
    revertHint: null,
  };
}

const ERC20_TRANSFER_TOPIC0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function hexToBigIntSafe(hex, fallback = 0n) {
  try {
    return BigInt(String(hex || "0x0"));
  } catch {
    return fallback;
  }
}

function parseTopicAddress(topic) {
  const t = String(topic || "");
  if (!/^0x[0-9a-fA-F]{64}$/.test(t)) return null;
  return `0x${t.slice(-40)}`.toLowerCase();
}

function parseTopicUint(topic) {
  const t = String(topic || "");
  if (!/^0x[0-9a-fA-F]{64}$/.test(t)) return null;
  return hexToBigIntSafe(t, null);
}

function decodeExactInputSingleInput(inputHex) {
  const s = String(inputHex || "").toLowerCase();
  if (!s.startsWith("0x1679c792")) return null;
  const body = s.slice(10);
  const wordsAvailable = Math.floor(body.length / 64);
  if (wordsAvailable < 4) return null;
  const word = (i) => body.slice(i * 64, (i + 1) * 64);
  const addrWord = (i) => {
    const w = word(i);
    if (!w || w.length !== 64) return null;
    return `0x${w.slice(24)}`.toLowerCase();
  };
  const uintWord = (i) => {
    const w = word(i);
    if (!w || w.length !== 64) return null;
    return hexToBigIntSafe(`0x${w}`, 0n);
  };

  const tokenIn = addrWord(0);
  const tokenOut = addrWord(1);
  const deployer = addrWord(2);
  const recipient = addrWord(3);
  if (!tokenIn || !tokenOut || !deployer || !recipient) return null;

  const strictAligned = body.length % 64 === 0;
  const fullV8 = strictAligned && wordsAvailable >= 8;
  const compatV7 = strictAligned && wordsAvailable === 7;

  return {
    tokenIn,
    tokenOut,
    deployer,
    recipient,
    deadline: fullV8 || compatV7 ? uintWord(4) : null,
    amountIn: fullV8 || compatV7 ? uintWord(5) : null,
    amountOutMinimum: fullV8 || compatV7 ? uintWord(6) : null,
    limitSqrtPrice: fullV8 ? uintWord(7) : compatV7 ? 0n : null,
    decodeShape: fullV8 ? "exactInputSingle_v8" : compatV7 ? "exactInputSingle_v7_compat" : "partial_malformed",
  };
}

function decodeApproveInput(inputHex) {
  const s = String(inputHex || "").toLowerCase();
  if (!s.startsWith("0x095ea7b3")) return null;
  const body = s.slice(10);
  if (body.length < 64 * 2) return null;
  const word = (i) => body.slice(i * 64, (i + 1) * 64);
  const addrWord = (i) => `0x${word(i).slice(24)}`.toLowerCase();
  const uintWord = (i) => hexToBigIntSafe(`0x${word(i)}`, 0n);
  return {
    spender: addrWord(0),
    amount: uintWord(1),
  };
}

function decodeMintInput(inputHex) {
  const s = String(inputHex || "").toLowerCase();
  if (!s.startsWith("0xfe3f3be7")) return null;
  const body = s.slice(10);
  if (body.length < 64 * 11) return null;
  const word = (i) => body.slice(i * 64, (i + 1) * 64);
  const addrWord = (i) => `0x${word(i).slice(24)}`.toLowerCase();
  const uintWord = (i) => hexToBigIntSafe(`0x${word(i)}`, 0n);
  const int24Word = (i) => {
    const raw = hexToBigIntSafe(`0x${word(i)}`, 0n);
    let v = raw & ((1n << 24n) - 1n);
    if ((v & (1n << 23n)) !== 0n) v -= 1n << 24n;
    return Number(v);
  };
  return {
    token0: addrWord(0),
    token1: addrWord(1),
    deployer: addrWord(2),
    tickLower: int24Word(3),
    tickUpper: int24Word(4),
    amount0Desired: uintWord(5),
    amount1Desired: uintWord(6),
    amount0Min: uintWord(7),
    amount1Min: uintWord(8),
    recipient: addrWord(9),
    deadline: uintWord(10),
  };
}

function decodeWordSafe(bodyHex, wordIndex) {
  const start = wordIndex * 64;
  const end = start + 64;
  if (start < 0 || end > bodyHex.length) return null;
  return bodyHex.slice(start, end);
}

function wordToSafeNumber(wordHex) {
  const n = hexToBigIntSafe(`0x${wordHex || "0"}`, -1n);
  if (n < 0n || n > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(n);
}

function decodeAbiBytesArrayFromBodyAtOffset(bodyHex, offsetBytes) {
  const base = offsetBytes * 2;
  if (!Number.isFinite(base) || base < 0 || base + 64 > bodyHex.length) return null;

  const lenWord = bodyHex.slice(base, base + 64);
  const count = wordToSafeNumber(lenWord);
  if (!Number.isFinite(count) || count < 0 || count > 256) return null;

  const out = [];
  for (let i = 0; i < count; i++) {
    const relWord = bodyHex.slice(base + 64 + i * 64, base + 64 + (i + 1) * 64);
    if (relWord.length !== 64) return null;
    const relOffsetBytes = wordToSafeNumber(relWord);
    if (!Number.isFinite(relOffsetBytes)) return null;

    // For dynamic arrays, element offsets are relative to the array head payload
    // (the area immediately after the length word), not the beginning of the length word.
    const elemBase = base + 64 + relOffsetBytes * 2;
    if (elemBase + 64 > bodyHex.length) return null;
    const elemLenWord = bodyHex.slice(elemBase, elemBase + 64);
    const elemLen = wordToSafeNumber(elemLenWord);
    if (!Number.isFinite(elemLen) || elemLen < 0) return null;

    const dataStart = elemBase + 64;
    const dataEnd = dataStart + elemLen * 2;
    if (dataEnd > bodyHex.length) return null;
    out.push(`0x${bodyHex.slice(dataStart, dataEnd)}`);
  }
  return out;
}

function decodeMulticallInput(inputHex) {
  const s = String(inputHex || "").toLowerCase();
  if (!s.startsWith("0xac9650d8")) return null;
  const body = s.slice(10);
  if (body.length < 64 * 2 || body.length % 64 !== 0) {
    return { ok: false, error: "malformed multicall calldata body" };
  }

  const w0 = decodeWordSafe(body, 0);
  const w1 = decodeWordSafe(body, 1);
  const candidateOffsets = [];
  const o0 = wordToSafeNumber(w0);
  const o1 = wordToSafeNumber(w1);
  if (o0 != null) candidateOffsets.push({ offset: o0, variant: "multicall(bytes[])" });
  if (o1 != null) candidateOffsets.push({ offset: o1, variant: "multicall(uint256,bytes[])", deadline: hexToBigIntSafe(`0x${w0}`, null) });

  for (const candidate of candidateOffsets) {
    if (candidate.offset < 0 || candidate.offset % 32 !== 0) continue;
    const calls = decodeAbiBytesArrayFromBodyAtOffset(body, candidate.offset);
    if (!Array.isArray(calls) || !calls.length) continue;
    const selectors = calls.map((x) => String(x || "").slice(0, 10).toLowerCase());
    return {
      ok: true,
      variant: candidate.variant,
      deadline: candidate.deadline ?? null,
      calls,
      selectors,
    };
  }

  return { ok: false, error: "unable to decode bytes[] payload from multicall input" };
}

function decodeSwapLikeInput(inputHex) {
  const direct = decodeExactInputSingleInput(inputHex);
  if (direct) return { ...direct, wrapper: "direct", multicall: null, callIndex: null };

  const multi = decodeMulticallInput(inputHex);
  if (!multi?.ok) return null;
  for (let i = 0; i < multi.calls.length; i++) {
    const nested = decodeExactInputSingleInput(multi.calls[i]);
    if (!nested) continue;
    return {
      ...nested,
      wrapper: "multicall",
      multicall: multi,
      callIndex: i,
    };
  }
  return null;
}

function decodeMintLikeInput(inputHex) {
  const direct = decodeMintInput(inputHex);
  if (direct) return { mint: direct, wrapper: "direct", multicall: null, callIndex: null };

  const multi = decodeMulticallInput(inputHex);
  if (!multi?.ok) return null;
  for (let i = 0; i < multi.calls.length; i++) {
    const nested = decodeMintInput(multi.calls[i]);
    if (!nested) continue;
    return {
      mint: nested,
      wrapper: "multicall",
      multicall: multi,
      callIndex: i,
    };
  }
  return null;
}

function decodeApproveForFarmingInput(inputHex) {
  const detailed = decodeApproveForFarmingInputDetailed(inputHex);
  if (!detailed?.ok) return null;
  return detailed.decoded;
}

function decodeApproveForFarmingInputDetailed(inputHex) {
  const s = String(inputHex || "").toLowerCase();
  if (!s.startsWith("0x832f630a")) return null;
  const body = s.slice(10);
  const words = body.length / 64;
  const isWordAligned = body.length % 64 === 0;
  if (!isWordAligned) {
    return {
      ok: false,
      error: `malformed calldata body length ${body.length} (not 32-byte word aligned)`,
      words,
      bytesTotal: Math.floor((s.length - 2) / 2),
      partial: null,
    };
  }
  const word = (i) => body.slice(i * 64, (i + 1) * 64);
  const partial = {};
  if (words >= 1) partial.tokenId = hexToBigIntSafe(`0x${word(0)}`, 0n);
  if (words >= 2) partial.word1Raw = `0x${word(1)}`;
  if (words >= 2) partial.addressMaybeWord1 = `0x${word(1).slice(24)}`.toLowerCase();
  if (words >= 3) partial.farmingAddress = `0x${word(2).slice(24)}`.toLowerCase();
  if (words >= 3) partial.approve = hexToBigIntSafe(`0x${word(1)}`, 0n) !== 0n;

  if (words !== 3) {
    return {
      ok: false,
      error: `expected exactly 3 words (tokenId,bool,address), got ${words}`,
      words,
      bytesTotal: Math.floor((s.length - 2) / 2),
      partial,
    };
  }

  const approveWord = hexToBigIntSafe(`0x${word(1)}`, 0n);
  if (approveWord !== 0n && approveWord !== 1n) {
    return {
      ok: false,
      error: `bool word must be 0 or 1, got ${approveWord.toString()}`,
      words,
      bytesTotal: Math.floor((s.length - 2) / 2),
      partial,
    };
  }

  const decoded = {
    tokenId: partial.tokenId,
    approve: approveWord === 1n,
    farmingAddress: partial.farmingAddress,
  };

  return {
    ok: true,
    words,
    bytesTotal: Math.floor((s.length - 2) / 2),
    partial,
    decoded,
  };
}

function decodeFarmingActionInput(inputHex, selector) {
  const s = String(inputHex || "").toLowerCase();
  if (!s.startsWith(selector)) return null;
  const body = s.slice(10);
  if (body.length < 64 * 5) return null;
  const word = (i) => body.slice(i * 64, (i + 1) * 64);
  return {
    rewardToken: `0x${word(0).slice(24)}`.toLowerCase(),
    bonusRewardToken: `0x${word(1).slice(24)}`.toLowerCase(),
    pool: `0x${word(2).slice(24)}`.toLowerCase(),
    nonce: hexToBigIntSafe(`0x${word(3)}`, 0n),
    tokenId: hexToBigIntSafe(`0x${word(4)}`, 0n),
  };
}

function decodeFarmingClaimInput(inputHex) {
  const s = String(inputHex || "").toLowerCase();
  if (!s.startsWith("0x2f2d783d")) return null;
  const body = s.slice(10);
  if (body.length < 64 * 3) return null;
  const word = (i) => body.slice(i * 64, (i + 1) * 64);
  return {
    rewardToken: `0x${word(0).slice(24)}`.toLowerCase(),
    to: `0x${word(1).slice(24)}`.toLowerCase(),
    amountRequested: hexToBigIntSafe(`0x${word(2)}`, 0n),
  };
}

function decodeMintReturnData(dataHex) {
  const s = String(dataHex || "").toLowerCase();
  if (!/^0x[0-9a-f]*$/.test(s)) {
    return { ok: false, error: "non-hex return data" };
  }
  const body = s.slice(2);
  if (!body) return { ok: false, error: "empty return data" };
  if (body.length % 64 !== 0) {
    return { ok: false, error: `misaligned return data length (${body.length})` };
  }
  const words = body.length / 64;
  if (words < 4) {
    return { ok: false, error: `returned ${words} words (expected >= 4)` };
  }
  const word = (i) => body.slice(i * 64, (i + 1) * 64);
  return {
    ok: true,
    tokenId: hexToBigIntSafe(`0x${word(0)}`, 0n),
    liquidity: hexToBigIntSafe(`0x${word(1)}`, 0n),
    amount0: hexToBigIntSafe(`0x${word(2)}`, 0n),
    amount1: hexToBigIntSafe(`0x${word(3)}`, 0n),
  };
}

async function replayEthCall({ fromAddress, toAddress, data, value = 0n, blockTag = "latest" } = {}) {
  try {
    const ret = await withRpcRetry(() => rpcCall(
      "eth_call",
      [{
        from: assertAddress(fromAddress),
        to: assertAddress(toAddress),
        data: String(data || "0x"),
        value: typeof value === "bigint" ? toHexQuantity(value) : String(value || "0x0"),
      }, blockTag]
    ));
    return { ok: true, returnData: ret, error: null, category: null, revertHint: null };
  } catch (err) {
    const msg = String(err?.message || err || "");
    if (/insufficient funds for gas \* price \+ value/i.test(msg)) {
      return {
        ok: false,
        returnData: null,
        error: msg,
        category: "insufficient_native_balance_for_replay",
        revertHint: "insufficient native balance for replay",
      };
    }
    const classified = classifyCallFailure(err);
    return {
      ok: false,
      returnData: null,
      error: err?.message || String(err),
      category: classified.category,
      revertHint: classified.revertHint,
    };
  }
}

async function simulateMintCall({ fromAddress, mintData, blockTag = "latest" } = {}) {
  const base = await replayEthCall({
    fromAddress,
    toAddress: KITTENSWAP_CONTRACTS.positionManager,
    data: mintData,
    value: 0n,
    blockTag,
  });
  if (!base.ok) return base;
  const decoded = decodeMintReturnData(base.returnData);
  if (!decoded.ok) {
    return {
      ok: false,
      returnData: base.returnData,
      error: `mint eth_call returned unexpected data: ${decoded.error}`,
      category: "unexpected_return_data",
      revertHint: null,
      mintPreview: null,
    };
  }
  return { ...base, mintPreview: decoded };
}

async function collectTokenMetaMap(addresses) {
  const out = new Map();
  await Promise.all(
    [...addresses].map(async (address) => {
      const addr = normalizeAddress(address);
      if (!addr) return;
      const [symbol, decimals] = await Promise.all([
        readErc20Symbol(addr).catch(() => "TOKEN"),
        readErc20Decimals(addr).catch(() => 18),
      ]);
      out.set(addr, { symbol, decimals });
    })
  );
  return out;
}

function summarizeTransfersForAddress(receipt, targetAddress) {
  const target = assertAddress(targetAddress);
  const logs = Array.isArray(receipt?.logs) ? receipt.logs : [];
  const perToken = new Map();

  for (const log of logs) {
    const token = normalizeAddress(log?.address);
    const topics = Array.isArray(log?.topics) ? log.topics : [];
    if (!token || topics.length < 3) continue;
    if (String(topics[0] || "").toLowerCase() !== ERC20_TRANSFER_TOPIC0) continue;

    const from = parseTopicAddress(topics[1]);
    const to = parseTopicAddress(topics[2]);
    if (!from && !to) continue;

    const amount = hexToBigIntSafe(log?.data, 0n);
    if (!perToken.has(token)) {
      perToken.set(token, {
        address: token,
        sent: 0n,
        received: 0n,
        transferCount: 0,
      });
    }

    const bucket = perToken.get(token);
    bucket.transferCount += 1;
    if (from === target) bucket.sent += amount;
    if (to === target) bucket.received += amount;
  }

  return [...perToken.values()]
    .map((x) => ({ ...x, net: x.received - x.sent }))
    .sort((a, b) => a.address.localeCompare(b.address));
}

function extractMintedPositionTokenIds(receipt, { positionManager = KITTENSWAP_CONTRACTS.positionManager, recipientAddress = null } = {}) {
  const targetManager = assertAddress(positionManager);
  const recipient = recipientAddress ? assertAddress(recipientAddress) : null;
  const logs = Array.isArray(receipt?.logs) ? receipt.logs : [];
  const ids = [];
  for (const log of logs) {
    const logAddress = normalizeAddress(log?.address || "");
    if (logAddress !== targetManager) continue;
    const topics = Array.isArray(log?.topics) ? log.topics : [];
    if (topics.length < 4) continue;
    if (String(topics[0] || "").toLowerCase() !== ERC20_TRANSFER_TOPIC0) continue;
    const from = parseTopicAddress(topics[1]);
    const to = parseTopicAddress(topics[2]);
    if (from !== ZERO_ADDRESS) continue;
    if (recipient && to !== recipient) continue;
    const tokenId = parseTopicUint(topics[3]);
    if (typeof tokenId === "bigint") ids.push(tokenId);
  }
  return [...new Set(ids.map((x) => x.toString()))].map((x) => BigInt(x));
}

async function loadPositionValueSnapshot(tokenIdRaw, { ownerAddress, stableQuoteCtx = null } = {}) {
  const tokenId = parseTokenId(tokenIdRaw);
  const ctx = await withRpcRetry(() => loadPositionContext(tokenId, { ownerAddress }));
  const stakedInfo = await classifyStakedStatus(tokenId);

  const latestBlock = await withRpcRetry(() => rpcGetBlockByNumber("latest", false)).catch(() => null);
  const nowTs = latestBlock?.timestamp ? Number(BigInt(latestBlock.timestamp)) : Math.floor(Date.now() / 1000);
  const deadline = BigInt(nowTs + 3600);

  let principal = { ok: true, amount0: 0n, amount1: 0n, error: null };
  if (ctx.position.liquidity > 0n) {
    try {
      const out = await withRpcRetry(() => simulateDecreaseLiquidity({
        tokenId,
        liquidity: ctx.position.liquidity,
        amount0Min: 0n,
        amount1Min: 0n,
        deadline,
        fromAddress: ownerAddress,
        positionManager: KITTENSWAP_CONTRACTS.positionManager,
      }));
      principal = { ok: true, amount0: out.amount0, amount1: out.amount1, error: null };
    } catch (e) {
      principal = { ok: false, amount0: null, amount1: null, error: e?.message || String(e) };
    }
  }

  let claimable = { ok: true, amount0: 0n, amount1: 0n, error: null };
  try {
    const out = await withRpcRetry(() => simulateCollect({
      tokenId,
      recipient: ownerAddress,
      fromAddress: ownerAddress,
      amount0Max: maxUint128(),
      amount1Max: maxUint128(),
      positionManager: KITTENSWAP_CONTRACTS.positionManager,
    }));
    claimable = { ok: true, amount0: out.amount0, amount1: out.amount1, error: null };
  } catch (e) {
    claimable = { ok: false, amount0: null, amount1: null, error: e?.message || String(e) };
  }

  const principal0 = unitsToNumber(principal.amount0, ctx.token0.decimals);
  const principal1 = unitsToNumber(principal.amount1, ctx.token1.decimals);
  const claim0 = unitsToNumber(claimable.amount0, ctx.token0.decimals);
  const claim1 = unitsToNumber(claimable.amount1, ctx.token1.decimals);

  const principalValueInToken1 = estimateValueInToken1({
    amount0: principal0,
    amount1: principal1,
    price1Per0: ctx.price1Per0,
  });
  const claimValueInToken1 = estimateValueInToken1({
    amount0: claim0,
    amount1: claim1,
    price1Per0: ctx.price1Per0,
  });

  const [stablePrincipal0, stablePrincipal1, stableClaim0, stableClaim1] = await Promise.all([
    principal.amount0 == null
      ? Promise.resolve({ ok: false, amountOut: null, amountOutRaw: null, stableToken: DEFAULT_USD_STABLE_TOKEN, stableMeta: null, route: "unavailable", errors: ["principal token0 unavailable"] })
      : quoteTokenAmountToStable(ctx.token0.address, principal.amount0, { stableQuoteCtx }),
    principal.amount1 == null
      ? Promise.resolve({ ok: false, amountOut: null, amountOutRaw: null, stableToken: DEFAULT_USD_STABLE_TOKEN, stableMeta: null, route: "unavailable", errors: ["principal token1 unavailable"] })
      : quoteTokenAmountToStable(ctx.token1.address, principal.amount1, { stableQuoteCtx }),
    claimable.amount0 == null
      ? Promise.resolve({ ok: false, amountOut: null, amountOutRaw: null, stableToken: DEFAULT_USD_STABLE_TOKEN, stableMeta: null, route: "unavailable", errors: ["claim token0 unavailable"] })
      : quoteTokenAmountToStable(ctx.token0.address, claimable.amount0, { stableQuoteCtx }),
    claimable.amount1 == null
      ? Promise.resolve({ ok: false, amountOut: null, amountOutRaw: null, stableToken: DEFAULT_USD_STABLE_TOKEN, stableMeta: null, route: "unavailable", errors: ["claim token1 unavailable"] })
      : quoteTokenAmountToStable(ctx.token1.address, claimable.amount1, { stableQuoteCtx }),
  ]);

  const stableMeta = stablePrincipal0.stableMeta || stablePrincipal1.stableMeta || stableClaim0.stableMeta || stableClaim1.stableMeta || null;
  const principalValueInStable = (
    Number.isFinite(stablePrincipal0.amountOut) || Number.isFinite(stablePrincipal1.amountOut)
  ) ? (Number(stablePrincipal0.amountOut || 0) + Number(stablePrincipal1.amountOut || 0)) : null;
  const claimValueInStable = (
    Number.isFinite(stableClaim0.amountOut) || Number.isFinite(stableClaim1.amountOut)
  ) ? (Number(stableClaim0.amountOut || 0) + Number(stableClaim1.amountOut || 0)) : null;

  const widthTicks = ctx.position.tickUpper - ctx.position.tickLower;
  const ticksFromLower = ctx.poolState.tick - ctx.position.tickLower;
  const ticksToUpper = ctx.position.tickUpper - ctx.poolState.tick;
  const inRange = ctx.poolState.tick >= ctx.position.tickLower && ctx.poolState.tick < ctx.position.tickUpper;

  return {
    tokenId,
    ownerAddress,
    ctx,
    stakedInfo,
    deadline,
    principal,
    claimable,
    principalHuman: {
      amount0: principal0,
      amount1: principal1,
    },
    claimableHuman: {
      amount0: claim0,
      amount1: claim1,
    },
    valueInToken1: {
      principal: principalValueInToken1,
      claimable: claimValueInToken1,
      total: Number.isFinite(principalValueInToken1) || Number.isFinite(claimValueInToken1)
        ? (principalValueInToken1 || 0) + (claimValueInToken1 || 0)
        : null,
    },
    valueInStable: {
      stableToken: stablePrincipal0.stableToken || DEFAULT_USD_STABLE_TOKEN,
      stableSymbol: stableMeta?.symbol || "USD",
      stableDecimals: stableMeta?.decimals ?? 6,
      principal: principalValueInStable,
      claimable: claimValueInStable,
      total: Number.isFinite(principalValueInStable) || Number.isFinite(claimValueInStable)
        ? (principalValueInStable || 0) + (claimValueInStable || 0)
        : null,
    },
    stableQuoteRoutes: {
      principal0: stablePrincipal0.route,
      principal1: stablePrincipal1.route,
      claimable0: stableClaim0.route,
      claimable1: stableClaim1.route,
    },
    stableQuoteErrors: [
      ...(stablePrincipal0.errors || []),
      ...(stablePrincipal1.errors || []),
      ...(stableClaim0.errors || []),
      ...(stableClaim1.errors || []),
    ].filter(Boolean),
    range: {
      inRange,
      widthTicks,
      currentTick: ctx.poolState.tick,
      lowerTick: ctx.position.tickLower,
      upperTick: ctx.position.tickUpper,
      ticksFromLower,
      ticksToUpper,
      pctFromLower: widthTicks > 0 ? (ticksFromLower / widthTicks) * 100 : null,
      pctToUpper: widthTicks > 0 ? (ticksToUpper / widthTicks) * 100 : null,
      priceToken1PerToken0: {
        current: ctx.price1Per0,
        lower: tickToPrice(ctx.position.tickLower, { decimals0: ctx.token0.decimals, decimals1: ctx.token1.decimals }),
        upper: tickToPrice(ctx.position.tickUpper, { decimals0: ctx.token0.decimals, decimals1: ctx.token1.decimals }),
      },
    },
  };
}

function pushPositionValueLines(lines, snap, { prefix = "" } = {}) {
  const { token0, token1 } = snap.ctx;
  const current1Per0 = snap.range.priceToken1PerToken0.current;
  const lower1Per0 = snap.range.priceToken1PerToken0.lower;
  const upper1Per0 = snap.range.priceToken1PerToken0.upper;

  lines.push(`${prefix}- token id: ${snap.tokenId.toString()}`);
  lines.push(`${prefix}  - nft owner: ${snap.ctx.nftOwner}`);
  lines.push(`${prefix}  - staked status: ${snap.stakedInfo?.label ?? "unknown"}`);
  lines.push(`${prefix}  - pool: ${snap.ctx.poolAddress}`);
  lines.push(`${prefix}  - pair: ${token0.symbol} (${token0.address}) / ${token1.symbol} (${token1.address})`);
  lines.push(`${prefix}  - liquidity: ${snap.ctx.position.liquidity.toString()}`);
  lines.push(`${prefix}  - ticks: [${snap.range.lowerTick}, ${snap.range.upperTick}] | current ${snap.range.currentTick} | spacing ${snap.ctx.tickSpacing}`);
  lines.push(`${prefix}  - in range: ${snap.range.inRange ? "YES" : "NO"} | from lower ${snap.range.pctFromLower == null ? "n/a" : fmtPct(snap.range.pctFromLower)} | to upper ${snap.range.pctToUpper == null ? "n/a" : fmtPct(snap.range.pctToUpper)}`);
  lines.push(`${prefix}  - price token1/token0: current=${current1Per0 == null ? "n/a" : fmtNum(current1Per0, { dp: 8 })} lower=${lower1Per0 == null ? "n/a" : fmtNum(lower1Per0, { dp: 8 })} upper=${upper1Per0 == null ? "n/a" : fmtNum(upper1Per0, { dp: 8 })}`);
  lines.push(`${prefix}  - principal if burn now (simulated): ${snap.principalHuman.amount0 == null ? "n/a" : fmtNum(snap.principalHuman.amount0, { dp: 8 })} ${token0.symbol} + ${snap.principalHuman.amount1 == null ? "n/a" : fmtNum(snap.principalHuman.amount1, { dp: 8 })} ${token1.symbol}`);
  lines.push(`${prefix}  - claimable now via collect() (simulated): ${snap.claimableHuman.amount0 == null ? "n/a" : fmtNum(snap.claimableHuman.amount0, { dp: 8 })} ${token0.symbol} + ${snap.claimableHuman.amount1 == null ? "n/a" : fmtNum(snap.claimableHuman.amount1, { dp: 8 })} ${token1.symbol}`);
  lines.push(`${prefix}  - est value (in ${token1.symbol}): principal=${snap.valueInToken1.principal == null ? "n/a" : fmtNum(snap.valueInToken1.principal, { dp: 6 })} claimable=${snap.valueInToken1.claimable == null ? "n/a" : fmtNum(snap.valueInToken1.claimable, { dp: 6 })} total=${snap.valueInToken1.total == null ? "n/a" : fmtNum(snap.valueInToken1.total, { dp: 6 })}`);
  lines.push(`${prefix}  - est value (live quote -> ${snap.valueInStable.stableSymbol}): principal=${snap.valueInStable.principal == null ? "n/a" : fmtNum(snap.valueInStable.principal, { dp: 6 })} claimable=${snap.valueInStable.claimable == null ? "n/a" : fmtNum(snap.valueInStable.claimable, { dp: 6 })} total=${snap.valueInStable.total == null ? "n/a" : fmtNum(snap.valueInStable.total, { dp: 6 })}`);
  lines.push(`${prefix}  - stable quote routes: principal(${token0.symbol}=${snap.stableQuoteRoutes.principal0 || "n/a"}, ${token1.symbol}=${snap.stableQuoteRoutes.principal1 || "n/a"})`);
  if (!snap.principal.ok && snap.principal.error) lines.push(`${prefix}  - principal simulation: error (${snap.principal.error})`);
  if (!snap.claimable.ok && snap.claimable.error) lines.push(`${prefix}  - claimable simulation: error (${snap.claimable.error})`);
  if (Array.isArray(snap.stableQuoteErrors) && snap.stableQuoteErrors.length) {
    lines.push(`${prefix}  - stable quote warnings: ${snap.stableQuoteErrors.slice(0, 2).join(" | ")}`);
  }
}

async function cmdHealth() {
  const [chain, block, gas] = await Promise.all([
    rpcChainId().catch((e) => ({ error: e.message })),
    rpcBlockNumber().catch((e) => ({ error: e.message })),
    rpcGasPrice().catch((e) => ({ error: e.message })),
  ]);

  const lines = [];
  lines.push("Kittenswap LP rebalance health");
  lines.push(`- expected chain id: ${DEFAULT_CHAIN_ID}`);
  lines.push(`- rpc url: ${DEFAULT_RPC_URL}`);

  if (chain?.error) lines.push(`- rpc chain id: ERROR (${chain.error})`);
  else lines.push(`- rpc chain id: ${chain.decimal} (${chain.hex})${String(chain.decimal) === String(DEFAULT_CHAIN_ID) ? "" : " [MISMATCH]"}`);

  if (block?.error) lines.push(`- latest block: ERROR (${block.error})`);
  else lines.push(`- latest block: ${block.decimal} (${block.hex})`);

  if (gas?.error) lines.push(`- gas price: ERROR (${gas.error})`);
  else lines.push(`- gas price: ${formatUnits(BigInt(gas), 9, { precision: 3 })} gwei`);

  return lines.join("\n");
}

async function readInventorySummary() {
  try {
    const raw = await readFile(INVENTORY_JSON_URL, "utf8");
    const parsed = JSON.parse(raw);
    return {
      ok: true,
      generatedAt: parsed?.generatedAt || null,
      uniqueTokens: Number(parsed?.stats?.uniqueTokens || 0),
      uniquePools: Number(parsed?.stats?.uniquePools || 0),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function cmdContracts() {
  const inventory = await readInventorySummary();
  const lines = [];
  lines.push("Kittenswap contracts (HyperEVM mainnet)");
  for (const [k, v] of Object.entries(KITTENSWAP_CONTRACTS)) {
    lines.push(`- ${k}: ${v}`);
    lines.push(`  - explorer: ${addressLink(v)}`);
  }
  lines.push("- canonical base tokens:");
  lines.push("  - WHYPE: 0x5555555555555555555555555555555555555555");
  lines.push("  - USD stablecoin: 0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb");
  lines.push("- full token/pair CA inventory:");
  lines.push("  - markdown: references/kittenswap-token-pair-inventory.md");
  lines.push("  - json: references/kittenswap-token-pair-inventory.json");
  lines.push("  - refresh: node skills/auto-kittenswap-lp-rebalance/scripts/refresh_kittenswap_inventory.mjs");
  if (inventory.ok) {
    lines.push(`  - generatedAt: ${inventory.generatedAt}`);
    lines.push(`  - coverage: ${inventory.uniqueTokens} tokens / ${inventory.uniquePools} pools`);
  } else {
    lines.push(`  - inventory status: unavailable (${inventory.error})`);
  }
  return lines.join("\n");
}

async function cmdAccount(args) {
  const sub = String(args._[1] ?? "list").toLowerCase();
  const tail = args._.slice(2);

  if (sub === "list") {
    const cfg = await loadConfig();
    const keys = Object.keys(cfg.accounts || {}).sort();
    const lines = [];
    lines.push("Saved accounts");
    if (!keys.length) {
      lines.push("- none");
      return lines.join("\n");
    }
    for (const k of keys) {
      const suffix = cfg.defaultAccount === k ? " (default)" : "";
      lines.push(`- ${k}: ${cfg.accounts[k]}${suffix}`);
    }
    return lines.join("\n");
  }

  if (sub === "add") {
    if (tail.length < 2) throw new Error('Usage: krlp account add "main" HL:0x... [--default]');
    const addr = extractAddress(tail[tail.length - 1]);
    const label = tail.slice(0, -1).join(" ").trim();
    if (!addr || !label) throw new Error('Usage: krlp account add "main" HL:0x... [--default]');
    await setAccountAlias({ label, address: addr, makeDefault: parseBoolFlag(args.default) });
    return `Saved ${addr} as "${label}"${parseBoolFlag(args.default) ? " (default)" : ""}`;
  }

  if (sub === "remove" || sub === "rm" || sub === "del" || sub === "delete") {
    const label = tail.join(" ").trim();
    if (!label) throw new Error('Usage: krlp account remove "main"');
    await removeAccountAlias({ label });
    return `Removed account alias "${label}"`;
  }

  if (sub === "default") {
    const label = tail.join(" ").trim();
    if (!label) throw new Error('Usage: krlp account default "main"');
    await setDefaultAccount({ label });
    return `Default account set to "${label}"`;
  }

  throw new Error(`Unknown account subcommand: ${sub}`);
}

async function cmdPolicy(args) {
  const sub = String(args._[1] ?? "show").toLowerCase();
  if (sub === "list") {
    const policies = await listPolicies();
    const lines = [];
    lines.push("Rebalance policies");
    for (const [name, p] of Object.entries(policies).sort()) {
      lines.push(`- ${name}: edge=${p.edgeBps}bps slippage=${p.slippageBps}bps deadline=${p.deadlineSeconds}s`);
    }
    return lines.join("\n");
  }

  if (sub === "show") {
    const name = args._[2] || "";
    const { key, policy } = await getPolicy(name);
    return [
      `Policy "${key}"`,
      `- edge bps: ${policy.edgeBps}`,
      `- slippage bps: ${policy.slippageBps}`,
      `- deadline seconds: ${policy.deadlineSeconds}`,
    ].join("\n");
  }

  if (sub === "set") {
    const name = args._[2] || "default";
    const edgeBps = args["edge-bps"] != null ? parseBps(args["edge-bps"], null, { min: 0, max: 10_000 }) : undefined;
    const slippageBps = args["slippage-bps"] != null ? parseBps(args["slippage-bps"], null, { min: 0, max: 10_000 }) : undefined;
    const deadlineSeconds = args["deadline-seconds"] != null ? parseSeconds(args["deadline-seconds"], null, { min: 1, max: 86_400 }) : undefined;

    const out = await upsertPolicy({
      name,
      edgeBps,
      slippageBps,
      deadlineSeconds,
      makeDefault: parseBoolFlag(args.default),
    });

    return [
      `Saved policy "${out.key}"`,
      `- edge bps: ${out.policy.edgeBps}`,
      `- slippage bps: ${out.policy.slippageBps}`,
      `- deadline seconds: ${out.policy.deadlineSeconds}`,
      `- default policy: ${out.defaultPolicy}`,
    ].join("\n");
  }

  throw new Error(`Unknown policy subcommand: ${sub}`);
}

async function cmdPosition({ tokenIdRaw, ownerRef = "" }) {
  const tokenId = parseTokenId(tokenIdRaw);
  const ownerAddress = ownerRef ? await resolveAddressInput(ownerRef, { allowDefault: false }) : null;
  const ctx = await loadPositionContext(tokenId, { ownerAddress });
  const status = evaluateRebalanceNeed({
    currentTick: ctx.poolState.tick,
    tickLower: ctx.position.tickLower,
    tickUpper: ctx.position.tickUpper,
    edgeBps: 1500,
  });
  const sidePct = rangeSidePercents(ctx.poolState.tick, ctx.position.tickLower, ctx.position.tickUpper);
  const stakedInfo = await classifyStakedStatus(tokenId);

  const lines = [];
  lines.push(`Kittenswap LP position ${tokenId.toString()}`);
  lines.push(`- position manager: ${KITTENSWAP_CONTRACTS.positionManager}`);
  lines.push(`- nft owner: ${ctx.nftOwner}`);
  lines.push(`- staked status: ${stakedInfo.label}`);
  lines.push(`- token0: ${ctx.position.token0}`);
  lines.push(`- token1: ${ctx.position.token1}`);
  lines.push(`- deployer: ${ctx.position.deployer}`);
  lines.push(`- pool: ${ctx.poolAddress}`);
  lines.push(`- pool link: ${addressLink(ctx.poolAddress)}`);
  lines.push(`- liquidity: ${ctx.position.liquidity.toString()}`);
  lines.push(`- ticks: [${ctx.position.tickLower}, ${ctx.position.tickUpper}] | current ${ctx.poolState.tick} | spacing ${ctx.tickSpacing}`);
  lines.push(`- range side pct: from lower=${sidePct.fromLowerPct == null ? "n/a" : fmtPct(sidePct.fromLowerPct)} | to upper=${sidePct.toUpperPct == null ? "n/a" : fmtPct(sidePct.toUpperPct)}`);
  lines.push(`- range health: ${status.reason} (outOfRange=${status.outOfRange}, nearEdge=${status.nearEdge})`);
  lines.push(`- uncollected fees: ${formatUnits(ctx.position.tokensOwed0, ctx.token0.decimals, { precision: 8 })} ${ctx.token0.symbol} + ${formatUnits(ctx.position.tokensOwed1, ctx.token1.decimals, { precision: 8 })} ${ctx.token1.symbol}`);
  lines.push(priceSection(ctx));
  lines.push("- token metadata:");
  lines.push(formatTokenLine(ctx.token0, { includeBalance: ownerAddress != null }));
  lines.push(formatTokenLine(ctx.token1, { includeBalance: ownerAddress != null }));

  if (ownerAddress) lines.push(`- wallet checked for balances: ${ownerAddress}`);
  return lines.join("\n");
}

async function cmdStatus({ tokenIdRaw, edgeBps }) {
  const tokenId = parseTokenId(tokenIdRaw);
  const ctx = await loadPositionContext(tokenId);
  const threshold = parseBps(edgeBps, 1500, { min: 0, max: 10_000 });
  const evald = evaluateRebalanceNeed({
    currentTick: ctx.poolState.tick,
    tickLower: ctx.position.tickLower,
    tickUpper: ctx.position.tickUpper,
    edgeBps: threshold,
  });

  const headroomPct = rangeHeadroomPct(ctx.poolState.tick, ctx.position.tickLower, ctx.position.tickUpper);
  const sidePct = rangeSidePercents(ctx.poolState.tick, ctx.position.tickLower, ctx.position.tickUpper);
  const rec = suggestCenteredRange({
    currentTick: ctx.poolState.tick,
    oldLower: ctx.position.tickLower,
    oldUpper: ctx.position.tickUpper,
    tickSpacing: ctx.tickSpacing,
  });

  const lines = [];
  lines.push(`Kittenswap LP rebalance status (${tokenId.toString()})`);
  lines.push(`- pool: ${ctx.poolAddress}`);
  lines.push(`- ticks: [${ctx.position.tickLower}, ${ctx.position.tickUpper}] | current ${ctx.poolState.tick}`);
  lines.push(`- width ticks: ${evald.widthTicks}`);
  lines.push(`- lower headroom: ${evald.lowerHeadroomTicks} ticks`);
  lines.push(`- upper headroom: ${evald.upperHeadroomTicks} ticks`);
  lines.push(`- side pct from lower: ${sidePct.fromLowerPct == null ? "n/a" : fmtPct(sidePct.fromLowerPct)}`);
  lines.push(`- side pct to upper: ${sidePct.toUpperPct == null ? "n/a" : fmtPct(sidePct.toUpperPct)}`);
  lines.push(`- min headroom pct: ${headroomPct == null ? "n/a" : fmtPct(headroomPct)}`);
  lines.push(`- edge threshold: ${threshold} bps (${evald.edgeBufferTicks} ticks)`);
  lines.push(`- rebalance: ${evald.shouldRebalance ? "YES" : "NO"} (${evald.reason})`);
  lines.push(`- suggested new range: [${rec.tickLower}, ${rec.tickUpper}]`);
  lines.push(priceSection(ctx));
  return lines.join("\n");
}

async function cmdHeartbeat({
  tokenIdRaw,
  ownerRef = "",
  recipientRef = "",
  policyRef = "",
  edgeBps = null,
  widthBumpTicks = null,
  slippageBps = null,
  deadlineSeconds = null,
  farmingCenterRef = "",
  eternalFarmingRef = "",
}) {
  const tokenId = parseTokenId(tokenIdRaw);
  const owner = await resolveAddressInput(ownerRef || "", { allowDefault: true });
  const recipient = recipientRef ? await resolveAddressInput(recipientRef, { allowDefault: false }) : owner;
  const threshold = parseBps(
    edgeBps == null || String(edgeBps).trim() === "" ? Number.NaN : edgeBps,
    500,
    { min: 0, max: 10_000 }
  );
  const ctx = await loadPositionContext(tokenId, { ownerAddress: owner });
  const evald = evaluateRebalanceNeed({
    currentTick: ctx.poolState.tick,
    tickLower: ctx.position.tickLower,
    tickUpper: ctx.position.tickUpper,
    edgeBps: threshold,
  });
  const headroomPct = rangeHeadroomPct(ctx.poolState.tick, ctx.position.tickLower, ctx.position.tickUpper);
  const sidePct = rangeSidePercents(ctx.poolState.tick, ctx.position.tickLower, ctx.position.tickUpper);
  const widthPolicy = computeCenteredRangeWithWidthBump({
    currentTick: ctx.poolState.tick,
    tickLower: ctx.position.tickLower,
    tickUpper: ctx.position.tickUpper,
    tickSpacing: ctx.tickSpacing,
    widthBumpTicks: parseNonNegativeIntegerOrDefault(widthBumpTicks, 100, "heartbeat width-bump-ticks"),
  });
  const rec = widthPolicy.rec;

  const { farmingCenter, eternalFarming } = await resolveFarmingContracts({
    farmingCenterRef,
    eternalFarmingRef,
  });

  const [tokenFarmedIn, key, depositIncentiveId] = await Promise.all([
    withRpcRetry(() => readTokenFarmedIn(tokenId, { positionManager: KITTENSWAP_CONTRACTS.positionManager })).catch(() => null),
    withRpcRetry(() => readEternalFarmingIncentiveKey(ctx.poolAddress, { eternalFarming })).catch(() => null),
    withRpcRetry(() => readFarmingCenterDeposit(tokenId, { farmingCenter })).catch(() => null),
  ]);
  const stakeState = classifyKittenswapFarmStakeState({
    tokenFarmedIn,
    farmingCenter,
    depositIncentiveId,
  });
  const isStaked = stakeState.stakedInKittenswap;
  const stakedInTargetCenter = normalizeAddress(tokenFarmedIn || "") === normalizeAddress(farmingCenter);
  const rewardTokenAddress = key?.rewardToken && key.rewardToken !== ZERO_ADDRESS ? key.rewardToken : null;
  const bonusRewardTokenAddress = key?.bonusRewardToken && key.bonusRewardToken !== ZERO_ADDRESS
    ? key.bonusRewardToken
    : null;

  let bonusRewardRateRaw = null;
  if (isStaked && depositIncentiveId && depositIncentiveId !== ZERO_BYTES32) {
    const incentiveState = await withRpcRetry(
      () => readEternalFarmingIncentive(depositIncentiveId, { eternalFarming })
    ).catch(() => null);
    if (incentiveState?.virtualPoolAddress && incentiveState.virtualPoolAddress !== ZERO_ADDRESS) {
      const virtualPoolState = await withRpcRetry(
        () => readEternalVirtualPoolRewardState(incentiveState.virtualPoolAddress)
      ).catch(() => null);
      bonusRewardRateRaw = virtualPoolState?.bonusRewardRate ?? null;
    }
  }
  const bonusRewardEmissionActive = isMeaningfulBigInt(bonusRewardRateRaw);
  const bonusRewardEmissionKnownZero = bonusRewardRateRaw === 0n;

  const [rewardMeta, bonusMeta, pendingReward, pendingBonusReward] = await Promise.all([
    rewardTokenAddress ? readTokenSnapshot(rewardTokenAddress).catch(() => null) : Promise.resolve(null),
    bonusRewardTokenAddress ? readTokenSnapshot(bonusRewardTokenAddress).catch(() => null) : Promise.resolve(null),
    rewardTokenAddress
      ? withRpcRetry(() => readEternalFarmingRewardBalance(owner, rewardTokenAddress, { eternalFarming })).catch(() => null)
      : Promise.resolve(null),
    bonusRewardTokenAddress
      ? withRpcRetry(() => readEternalFarmingRewardBalance(owner, bonusRewardTokenAddress, { eternalFarming })).catch(() => null)
      : Promise.resolve(null),
  ]);

  const rewardMode = describeRewardMode({
    hasBonusRewardToken: Boolean(bonusRewardTokenAddress),
    bonusRewardEmissionActive,
    bonusRewardEmissionKnownZero,
  });
  const decision = evald.shouldRebalance ? "REBALANCE_COMPOUND_RESTAKE" : "HOLD";
  const shouldRebalance = evald.shouldRebalance;

  const statusCmdParts = ["krlp", "status", tokenId.toString(), "--edge-bps", String(threshold)];
  const farmStatusCmdParts = ["krlp", "farm-status", tokenId.toString(), owner];
  pushCommandFlag(farmStatusCmdParts, "farming-center", farmingCenter);
  pushCommandFlag(farmStatusCmdParts, "eternal-farming", eternalFarming);

  const planCmdParts = ["krlp", "plan", tokenId.toString(), owner, "--recipient", recipient, "--edge-bps", String(threshold)];
  pushCommandFlag(planCmdParts, "width-bump-ticks", String(widthPolicy.bumpRequested));
  pushCommandFlag(planCmdParts, "policy", policyRef || "");
  pushCommandFlag(planCmdParts, "slippage-bps", slippageBps);
  pushCommandFlag(planCmdParts, "deadline-seconds", deadlineSeconds);

  const farmExitCmdParts = ["krlp", "farm-exit-plan", tokenId.toString(), owner, "--auto-key"];
  pushCommandFlag(farmExitCmdParts, "farming-center", farmingCenter);
  pushCommandFlag(farmExitCmdParts, "eternal-farming", eternalFarming);
  const farmCollectCmdParts = ["krlp", "farm-collect-plan", tokenId.toString(), owner, "--auto-key"];
  pushCommandFlag(farmCollectCmdParts, "farming-center", farmingCenter);
  pushCommandFlag(farmCollectCmdParts, "eternal-farming", eternalFarming);

  const rewardClaimCmdParts = ["krlp", "farm-claim-plan", rewardTokenAddress || "<rewardToken>", owner, "--amount", "max"];
  pushCommandFlag(rewardClaimCmdParts, "farming-center", farmingCenter);
  pushCommandFlag(rewardClaimCmdParts, "eternal-farming", eternalFarming);
  const bonusClaimCmdParts = ["krlp", "farm-claim-plan", bonusRewardTokenAddress || "<bonusRewardToken>", owner, "--amount", "max"];
  pushCommandFlag(bonusClaimCmdParts, "farming-center", farmingCenter);
  pushCommandFlag(bonusClaimCmdParts, "eternal-farming", eternalFarming);

  const restakeStatusCmdParts = ["krlp", "farm-status", "<newTokenId>", owner];
  pushCommandFlag(restakeStatusCmdParts, "farming-center", farmingCenter);
  pushCommandFlag(restakeStatusCmdParts, "eternal-farming", eternalFarming);
  const restakeApproveCmdParts = ["krlp", "farm-approve-plan", "<newTokenId>", owner];
  pushCommandFlag(restakeApproveCmdParts, "farming-center", farmingCenter);
  pushCommandFlag(restakeApproveCmdParts, "eternal-farming", eternalFarming);
  const restakeEnterCmdParts = ["krlp", "farm-enter-plan", "<newTokenId>", owner, "--auto-key"];
  pushCommandFlag(restakeEnterCmdParts, "farming-center", farmingCenter);
  pushCommandFlag(restakeEnterCmdParts, "eternal-farming", eternalFarming);

  const lines = [];
  lines.push(`Kittenswap heartbeat plan (${tokenId.toString()})`);
  lines.push(`- timestamp utc: ${new Date().toISOString()}`);
  lines.push(`- owner/sender: ${owner}`);
  lines.push(`- recipient: ${recipient}`);
  lines.push(`- pool: ${ctx.poolAddress}`);
  lines.push(`- pair: ${ctx.token0.symbol} (${ctx.token0.address}) / ${ctx.token1.symbol} (${ctx.token1.address})`);
  lines.push(`- ticks: [${ctx.position.tickLower}, ${ctx.position.tickUpper}] | current ${ctx.poolState.tick}`);
  lines.push(`- current width ticks: ${widthPolicy.baseWidth}`);
  lines.push(`- side pct from lower: ${sidePct.fromLowerPct == null ? "n/a" : fmtPct(sidePct.fromLowerPct)}`);
  lines.push(`- side pct to upper: ${sidePct.toUpperPct == null ? "n/a" : fmtPct(sidePct.toUpperPct)}`);
  lines.push(`- min headroom pct: ${headroomPct == null ? "n/a" : fmtPct(headroomPct)}`);
  lines.push(`- heartbeat edge threshold: ${threshold} bps (${fmtPct(threshold / 100)})`);
  lines.push(`- auto widen policy on rebalance: +${widthPolicy.bumpRequested} ticks requested (+${widthPolicy.bumpApplied} applied by spacing)`);
  lines.push(`- rebalance trigger rule: OUT_OF_RANGE OR min_headroom_pct <= ${fmtPct(threshold / 100)}`);
  lines.push(`- rebalance evaluation: ${shouldRebalance ? "TRIGGERED" : "NO_TRIGGER"} (${evald.reason})`);
  lines.push(`- decision: ${decision}`);
  lines.push(`- farming center: ${farmingCenter}`);
  lines.push(`- eternal farming: ${eternalFarming}`);
  lines.push(`- canonical stake status code: ${stakeState.statusCode}`);
  lines.push(`- staked in configured Kittenswap farm: ${isStaked ? "YES" : "NO"}`);
  lines.push(`- staking reason: ${stakeState.reason}`);
  lines.push(`- tokenFarmedIn raw: ${tokenFarmedIn || ZERO_ADDRESS}`);
  lines.push(`- deposit incentiveId raw: ${depositIncentiveId || ZERO_BYTES32}`);
  lines.push(`- reward mode: ${rewardMode.code}`);
  lines.push(`- reward mode detail: ${rewardMode.detail}`);
  if (rewardTokenAddress) {
    lines.push(`- primary reward token: ${rewardTokenAddress}${rewardMeta ? ` (${rewardMeta.symbol})` : ""}`);
    lines.push(`- pending reward now: ${pendingReward == null ? "n/a" : formatUnits(pendingReward, rewardMeta?.decimals ?? 18, { precision: 8 })} ${rewardMeta?.symbol || rewardTokenAddress}`);
  }
  if (bonusRewardTokenAddress && bonusRewardEmissionActive) {
    lines.push(`- secondary reward token (bonus): ${bonusRewardTokenAddress}${bonusMeta ? ` (${bonusMeta.symbol})` : ""}`);
    lines.push(`- pending bonus now: ${pendingBonusReward == null ? "n/a" : formatUnits(pendingBonusReward, bonusMeta?.decimals ?? 18, { precision: 8 })} ${bonusMeta?.symbol || bonusRewardTokenAddress}`);
  }
  if (!isStaked && (stakeState.stakedElsewhere || stakeState.statusCode === "INCONSISTENT_FARM_STATE")) {
    lines.push("- BLOCKER: canonical staking checks did not pass; do not run farm-exit/collect until status is STAKED_KITTENSWAP.");
  }
  if (isStaked && !stakedInTargetCenter) {
    lines.push(`- BLOCKER: token is farmed in ${tokenFarmedIn}, not the configured farming center ${farmingCenter}.`);
  }
  if (rewardTokenAddress == null && isStaked) {
    lines.push("- BLOCKER: no active reward token found for this pool; verify incentive key before farming actions.");
  }

  lines.push("- heartbeat hard rules for weak LLM execution:");
  lines.push("  1. Never hand-encode calldata. Use only krlp *-plan command outputs.");
  lines.push("  2. Stop immediately if any output contains BLOCKER or simulation REVERT.");
  lines.push("  3. Send dependent transactions sequentially. Never parallelize approve/swap/mint/farm steps.");
  lines.push("  4. Run krlp tx-verify <txHash> after each broadcast before continuing.");
  lines.push("  5. Do not burn old NFT unless explicit --allow-burn was requested in plan.");

  lines.push("- phase 1 preflight commands:");
  lines.push(`  1. ${renderCommand(statusCmdParts)}`);
  lines.push(`  2. ${renderCommand(farmStatusCmdParts)}`);

  if (!shouldRebalance) {
    lines.push("- phase 2 action branch: HOLD");
    lines.push("  - Do not exit farming and do not remint LP on this heartbeat.");
    lines.push("  - Optional rewards harvest only:");
    if (isStaked) {
      lines.push(`    1. ${renderCommand(farmCollectCmdParts)}`);
      lines.push(`    2. ${renderCommand(rewardClaimCmdParts)}`);
      if (bonusRewardTokenAddress && bonusRewardEmissionActive) {
        lines.push(`    3. ${renderCommand(bonusClaimCmdParts)}`);
      }
    } else {
      lines.push("    1. Position is not staked; no farming harvest step required.");
    }
    lines.push("- heartbeat result: HOLD (anti-churn rule enforced by 5% threshold)");
    lines.push("- width update: skipped (widening applies only when a rebalance is actually triggered)");
    return lines.join("\n");
  }

  lines.push("- phase 2 action branch: REBALANCE_COMPOUND_RESTAKE");
  lines.push("  - Goal: exit/claim -> remove LP -> rebalance inventory 50/50 -> mint replacement -> stake replacement.");
  lines.push(`  - target replacement width: ${widthPolicy.targetWidth} ticks (current ${widthPolicy.baseWidth} + ${widthPolicy.bumpApplied})`);
  lines.push(`  - target replacement ticks now: [${rec.tickLower}, ${rec.tickUpper}]`);
  if (isStaked) {
    lines.push("- phase 3 farming exit and reward claim:");
    lines.push(`  1. ${renderCommand(farmExitCmdParts)}`);
    lines.push(`  2. ${renderCommand(rewardClaimCmdParts)}`);
    if (bonusRewardTokenAddress && bonusRewardEmissionActive) {
      lines.push(`  3. ${renderCommand(bonusClaimCmdParts)}`);
    }
  } else {
    lines.push("- phase 3 farming exit and reward claim: skipped (position not currently staked)");
  }

  lines.push("- phase 4 rebalance and mint planning:");
  lines.push(`  1. ${renderCommand(planCmdParts)}`);
  lines.push("  2. Execute plan transaction templates in exact order (collect -> decrease -> collect -> approvals -> mint).");
  lines.push("  3. Re-run plan right before signing if block advanced materially or prices moved.");
  lines.push("  4. Include claimed KITTEN rewards in 50/50 rebalance before mint.");

  lines.push("- phase 5 immediate restake of minted replacement:");
  lines.push(`  1. ${renderCommand(restakeStatusCmdParts)}`);
  lines.push(`  2. ${renderCommand(restakeApproveCmdParts)}`);
  lines.push(`  3. ${renderCommand(restakeEnterCmdParts)}`);

  lines.push("- heartbeat result: REBALANCE_COMPOUND_RESTAKE");
  lines.push(`- suggested centered replacement range now: [${rec.tickLower}, ${rec.tickUpper}]`);
  return lines.join("\n");
}

async function cmdValue({ tokenIdRaw, ownerRef = "" }) {
  const tokenId = parseTokenId(tokenIdRaw);
  const ownerAddress = ownerRef
    ? await resolveAddressInput(ownerRef, { allowDefault: false })
    : await withRpcRetry(() => readOwnerOf(tokenId, { positionManager: KITTENSWAP_CONTRACTS.positionManager }));

  const stableQuoteCtx = createStableQuoteContext();
  const snap = await loadPositionValueSnapshot(tokenId, { ownerAddress, stableQuoteCtx });
  const lines = [];
  lines.push(`Kittenswap LP valuation snapshot (${tokenId.toString()})`);
  lines.push(`- wallet (simulation from): ${ownerAddress}`);
  lines.push(`- position manager: ${KITTENSWAP_CONTRACTS.positionManager}`);
  lines.push(`- nft owner: ${snap.ctx.nftOwner}`);
  lines.push(`- pool link: ${addressLink(snap.ctx.poolAddress)}`);
  lines.push(`- stable valuation token: ${snap.valueInStable.stableSymbol} (${snap.valueInStable.stableToken})`);
  lines.push(`- method (principal): eth_call decreaseLiquidity(tokenId, fullLiquidity, 0, 0, deadline)`);
  lines.push(`- method (rewards): eth_call collect(tokenId, recipient, maxUint128, maxUint128)`);
  lines.push("- method (USD mark): quoteExactInputSingle direct or via WHYPE bridge into stable token");
  pushPositionValueLines(lines, snap);
  lines.push("- safety:");
  lines.push("  - this is deterministic read/simulation only (no signing, no broadcast)");
  lines.push("  - output uses full addresses and full numeric values (no truncation)");
  return lines.join("\n");
}

async function cmdWallet({ ownerRef = "", activeOnly = false }) {
  const ownerAddress = await resolveAddressInput(ownerRef || "", { allowDefault: true });
  const manager = KITTENSWAP_CONTRACTS.positionManager;

  const tokenIds = await withRpcRetry(() => listOwnedTokenIds(ownerAddress, { positionManager: manager }));
  const stableQuoteCtx = createStableQuoteContext();
  const rewardTotals = new Map();
  const rewardTokenMeta = new Map();
  const activeTokenIds = [];
  let rewardScanErrors = 0;

  for (const tokenId of tokenIds) {
    let pos = null;
    try {
      pos = await withRpcRetry(() => readPosition(tokenId, { positionManager: manager }));
    } catch {
      rewardScanErrors += 1;
      continue;
    }
    if (pos.liquidity > 0n) activeTokenIds.push(tokenId);

    try {
      const claim = await withRpcRetry(() => simulateCollect({
        tokenId,
        recipient: ownerAddress,
        fromAddress: ownerAddress,
        amount0Max: maxUint128(),
        amount1Max: maxUint128(),
        positionManager: manager,
      }));

      rewardTotals.set(pos.token0, (rewardTotals.get(pos.token0) || 0n) + claim.amount0);
      rewardTotals.set(pos.token1, (rewardTotals.get(pos.token1) || 0n) + claim.amount1);
    } catch {
      rewardScanErrors += 1;
    }

    if (!rewardTokenMeta.has(pos.token0)) rewardTokenMeta.set(pos.token0, await readTokenSnapshot(pos.token0).catch(() => null));
    if (!rewardTokenMeta.has(pos.token1)) rewardTokenMeta.set(pos.token1, await readTokenSnapshot(pos.token1).catch(() => null));
  }

  const idsForValue = activeOnly ? activeTokenIds : tokenIds;
  const activeSet = new Set(activeTokenIds.map((x) => x.toString()));
  const idsToSnapshot = idsForValue.filter((id) => activeSet.has(id.toString()));

  const snapshots = [];
  for (const tokenId of idsToSnapshot) {
    try {
      const snap = await loadPositionValueSnapshot(tokenId, { ownerAddress, stableQuoteCtx });
      snapshots.push(snap);
    } catch {
      rewardScanErrors += 1;
    }
  }

  const totalByQuoteToken = new Map();
  let totalWithValues = 0;
  let stableTotalWithValues = 0;
  let stablePrincipalTotal = 0;
  let stableClaimableTotal = 0;
  const stableSymbol = snapshots[0]?.valueInStable?.stableSymbol || "USD";
  const stableAddress = snapshots[0]?.valueInStable?.stableToken || DEFAULT_USD_STABLE_TOKEN;
  for (const snap of snapshots) {
    const token1Address = snap.ctx.token1.address;
    const token1Symbol = snap.ctx.token1.symbol;
    if (!totalByQuoteToken.has(token1Address)) {
      totalByQuoteToken.set(token1Address, {
        symbol: token1Symbol,
        principal: 0,
        claimable: 0,
      });
    }
    const bucket = totalByQuoteToken.get(token1Address);
    if (Number.isFinite(snap.valueInToken1.principal)) bucket.principal += snap.valueInToken1.principal;
    if (Number.isFinite(snap.valueInToken1.claimable)) bucket.claimable += snap.valueInToken1.claimable;
    if (Number.isFinite(snap.valueInToken1.total)) totalWithValues += 1;
    if (Number.isFinite(snap.valueInStable.principal)) stablePrincipalTotal += snap.valueInStable.principal;
    if (Number.isFinite(snap.valueInStable.claimable)) stableClaimableTotal += snap.valueInStable.claimable;
    if (Number.isFinite(snap.valueInStable.total)) stableTotalWithValues += 1;
  }

  const lines = [];
  lines.push("Kittenswap wallet portfolio snapshot");
  lines.push(`- wallet: ${ownerAddress}`);
  lines.push(`- position manager: ${manager}`);
  lines.push(`- total position NFTs: ${tokenIds.length}`);
  lines.push(`- active positions (liquidity > 0): ${activeTokenIds.length}`);
  lines.push(`- inactive positions: ${tokenIds.length - activeTokenIds.length}`);
  lines.push(`- value snapshots generated: ${snapshots.length}${activeOnly ? " (active-only mode)" : ""}`);
  lines.push(`- rpc scan errors: ${rewardScanErrors}`);

  lines.push("- aggregate claimable rewards across scanned NFTs (collect simulation):");
  if (!rewardTotals.size) {
    lines.push("  - none");
  } else {
    for (const [tokenAddress, raw] of [...rewardTotals.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const meta = rewardTokenMeta.get(tokenAddress);
      if (!meta) {
        lines.push(`  - ${tokenAddress}: ${raw.toString()} (raw)`);
      } else {
        lines.push(`  - ${meta.symbol} (${tokenAddress}): ${formatUnits(raw, meta.decimals, { precision: 8 })}`);
      }
    }
  }

  if (snapshots.length) {
    lines.push(`- aggregate active-position value (live quote -> ${stableSymbol} ${stableAddress}):`);
    lines.push(`  - principal=${fmtNum(stablePrincipalTotal, { dp: 6 })} claimable=${fmtNum(stableClaimableTotal, { dp: 6 })} total=${fmtNum(stablePrincipalTotal + stableClaimableTotal, { dp: 6 })}`);
    lines.push(`  - coverage: ${stableTotalWithValues}/${snapshots.length} positions`);
    lines.push("- aggregate active-position value (grouped by quote token):");
    for (const [tokenAddress, bucket] of [...totalByQuoteToken.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`  - ${bucket.symbol} (${tokenAddress}): principal=${fmtNum(bucket.principal, { dp: 6 })} claimable=${fmtNum(bucket.claimable, { dp: 6 })} total=${fmtNum(bucket.principal + bucket.claimable, { dp: 6 })}`);
    }
    lines.push("- active position details:");
    for (const snap of snapshots) {
      pushPositionValueLines(lines, snap, { prefix: "  " });
    }
  } else {
    lines.push("- active position details: none");
  }

  lines.push("- methodology:");
  lines.push("  - enumerate NFTs via balanceOf + tokenOfOwnerByIndex on position manager");
  lines.push("  - read position data via positions(tokenId)");
  lines.push("  - rewards via collect() eth_call simulation from wallet");
  lines.push("  - principal via decreaseLiquidity() eth_call simulation for active positions");
  lines.push("  - range/price from pool globalState tick + token decimals");
  lines.push("  - stable mark via quoteExactInputSingle (direct or bridged through WHYPE)");
  lines.push("  - no signatures used; no transactions broadcast");

  if (totalWithValues < snapshots.length) {
    lines.push("- note: some position values were n/a due to simulation/read failures; review per-position error lines");
  }

  return lines.join("\n");
}

async function cmdFarmStakedSummary({
  ownerRef = "",
  activeOnly = false,
  farmingCenterRef = "",
  eternalFarmingRef = "",
}) {
  const ownerAddress = await resolveAddressInput(ownerRef || "", { allowDefault: true });
  const { farmingCenter, eternalFarming } = await resolveFarmingContracts({
    farmingCenterRef,
    eternalFarmingRef,
  });

  const tokenIds = await withRpcRetry(() => listOwnedTokenIds(ownerAddress, {
    positionManager: KITTENSWAP_CONTRACTS.positionManager,
  }));

  const tokenMetaCache = new Map();
  const readTokenMetaCached = async (tokenAddress) => {
    const addr = normalizeAddress(tokenAddress);
    if (!addr) return null;
    if (!tokenMetaCache.has(addr)) {
      tokenMetaCache.set(addr, await readTokenSnapshot(addr).catch(() => null));
    }
    return tokenMetaCache.get(addr);
  };

  const rows = [];
  for (const tokenId of tokenIds) {
    let pos = null;
    let tokenFarmedIn = null;
    let depositIncentiveId = null;
    let primaryRewardRateRaw = null;
    let readError = null;

    try {
      [pos, tokenFarmedIn, depositIncentiveId] = await Promise.all([
        withRpcRetry(() => readPosition(tokenId, { positionManager: KITTENSWAP_CONTRACTS.positionManager })),
        withRpcRetry(() => readTokenFarmedIn(tokenId, { positionManager: KITTENSWAP_CONTRACTS.positionManager })).catch(() => ZERO_ADDRESS),
        withRpcRetry(() => readFarmingCenterDeposit(tokenId, { farmingCenter })).catch(() => ZERO_BYTES32),
      ]);
    } catch (err) {
      readError = err?.message || String(err);
    }

    if (pos && parseBoolFlag(activeOnly) && pos.liquidity <= 0n) continue;

    let pair = "n/a";
    let pool = null;
    let liquidity = pos?.liquidity?.toString?.() || "n/a";
    if (pos) {
      pool = await withRpcRetry(() => readPoolAddressByPair(pos.token0, pos.token1, {
        factory: KITTENSWAP_CONTRACTS.factory,
      })).catch(() => null);
      const [token0Meta, token1Meta] = await Promise.all([
        readTokenMetaCached(pos.token0),
        readTokenMetaCached(pos.token1),
      ]);
      const s0 = token0Meta?.symbol || pos.token0;
      const s1 = token1Meta?.symbol || pos.token1;
      pair = `${s0}/${s1}`;
    }

    const state = classifyKittenswapFarmStakeState({
      tokenFarmedIn,
      farmingCenter,
      depositIncentiveId,
    });

    if (state.stakedInKittenswap && hasNonZeroBytes32(depositIncentiveId)) {
      const incentiveState = await withRpcRetry(() => readEternalFarmingIncentive(depositIncentiveId, { eternalFarming })).catch(() => null);
      if (incentiveState?.virtualPoolAddress && incentiveState.virtualPoolAddress !== ZERO_ADDRESS) {
        const virtualState = await withRpcRetry(() => readEternalVirtualPoolRewardState(incentiveState.virtualPoolAddress)).catch(() => null);
        primaryRewardRateRaw = virtualState?.rewardRate ?? null;
      }
    }

    const earningPrimary = Boolean(
      state.stakedInKittenswap
      && typeof primaryRewardRateRaw === "bigint"
      && primaryRewardRateRaw > 0n
      && pos
      && pos.liquidity > 0n
    );

    rows.push({
      tokenId: tokenId.toString(),
      pair,
      pool: pool || "n/a",
      liquidity,
      tokenFarmedIn: tokenFarmedIn || ZERO_ADDRESS,
      depositIncentiveId: depositIncentiveId || ZERO_BYTES32,
      stakedInKittenswap: state.stakedInKittenswap,
      stakedElsewhere: state.stakedElsewhere,
      statusCode: readError ? "READ_ERROR" : state.statusCode,
      reason: readError ? `read failure: ${readError}` : state.reason,
      primaryRewardRateRaw,
      earningPrimary,
    });
  }

  rows.sort((a, b) => Number(a.tokenId) - Number(b.tokenId));

  const total = rows.length;
  const countStaked = rows.filter((r) => r.stakedInKittenswap).length;
  const countOther = rows.filter((r) => r.statusCode === "STAKED_OTHER_CONTRACT").length;
  const countNot = rows.filter((r) => r.statusCode === "NOT_STAKED").length;
  const countInconsistent = rows.filter((r) => r.statusCode === "INCONSISTENT_FARM_STATE").length;
  const countError = rows.filter((r) => r.statusCode === "READ_ERROR").length;

  const lines = [];
  lines.push("Kittenswap farm staked summary");
  lines.push(`- wallet: ${ownerAddress}`);
  lines.push(`- farming center: ${farmingCenter}`);
  lines.push(`- eternal farming: ${eternalFarming}`);
  lines.push(`- positions scanned: ${total}${parseBoolFlag(activeOnly) ? " (active-only liquidity > 0)" : ""}`);
  lines.push(`- staked in configured Kittenswap farm: ${countStaked}`);
  lines.push(`- not staked: ${countNot}`);
  lines.push(`- staked in other contract: ${countOther}`);
  lines.push(`- inconsistent farm state: ${countInconsistent}`);
  lines.push(`- read errors: ${countError}`);
  lines.push("- canonical staked rule for Kittenswap actions:");
  lines.push(`  - REQUIRE tokenFarmedIn == ${farmingCenter}`);
  lines.push("  - REQUIRE farmingCenter deposit incentiveId != 0x000...000");
  lines.push("  - if either check fails, treat as NOT_STAKED for Kittenswap collect/exit/claim workflow");

  if (!rows.length) {
    lines.push("- no positions found for wallet");
    return lines.join("\n");
  }

  lines.push("| tokenId | pair | liquidity | tokenFarmedIn | depositIncentiveId | stakedInKittenswap | earningPrimary | statusCode |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const row of rows) {
    const rewardRate = row.primaryRewardRateRaw == null
      ? "n/a"
      : formatUnits(row.primaryRewardRateRaw, 18, { precision: 8 });
    lines.push(`| ${row.tokenId} | ${row.pair} | ${row.liquidity} | ${row.tokenFarmedIn} | ${row.depositIncentiveId} | ${row.stakedInKittenswap ? "YES" : "NO"} | ${row.earningPrimary ? `YES (${rewardRate} KITTEN/s)` : "NO"} | ${row.statusCode} |`);
  }

  lines.push("- status code meanings:");
  lines.push("  - STAKED_KITTENSWAP: canonical checks passed; token is staked in configured Kittenswap farm");
  lines.push("  - NOT_STAKED: tokenFarmedIn is zero address");
  lines.push("  - STAKED_OTHER_CONTRACT: tokenFarmedIn is non-zero but not configured farming center");
  lines.push("  - INCONSISTENT_FARM_STATE: farmedIn matches center but deposit incentiveId is zero/invalid");
  lines.push("  - READ_ERROR: chain reads failed; do not infer stake state");
  lines.push("- weak-LLM execution rule: only run farm-exit/collect on rows where statusCode = STAKED_KITTENSWAP.");
  return lines.join("\n");
}

async function cmdFarmStatus({
  tokenIdRaw,
  ownerRef = "",
  farmingCenterRef = "",
  eternalFarmingRef = "",
}) {
  const tokenId = parseTokenId(tokenIdRaw);
  const owner = ownerRef ? await resolveAddressInput(ownerRef, { allowDefault: false }) : null;
  const { farmingCenter, eternalFarming, managerFarmingCenter } = await resolveFarmingContracts({
    farmingCenterRef,
    eternalFarmingRef,
  });

  const [nftOwner, pos] = await Promise.all([
    withRpcRetry(() => readOwnerOf(tokenId, { positionManager: KITTENSWAP_CONTRACTS.positionManager })),
    withRpcRetry(() => readPosition(tokenId, { positionManager: KITTENSWAP_CONTRACTS.positionManager })),
  ]);
  const pool = await withRpcRetry(() => readPoolAddressByPair(pos.token0, pos.token1, { factory: KITTENSWAP_CONTRACTS.factory }));
  const [farmingApproval, tokenFarmedIn, depositIncentiveId, tokenApproval, operatorApproval] = await Promise.all([
    withRpcRetry(() => readPositionFarmingApproval(tokenId, { positionManager: KITTENSWAP_CONTRACTS.positionManager })).catch(() => null),
    withRpcRetry(() => readTokenFarmedIn(tokenId, { positionManager: KITTENSWAP_CONTRACTS.positionManager })).catch(() => null),
    withRpcRetry(() => readFarmingCenterDeposit(tokenId, { farmingCenter })).catch(() => null),
    withRpcRetry(() => readPositionManagerTokenApproval(tokenId, { positionManager: KITTENSWAP_CONTRACTS.positionManager })).catch(() => null),
    withRpcRetry(() => readPositionManagerIsApprovedForAll(nftOwner, farmingCenter, { positionManager: KITTENSWAP_CONTRACTS.positionManager })).catch(() => null),
  ]);
  const tokenTransferApprovalOk = hasFarmingTokenTransferApproval({ tokenApproval, operatorApproved: operatorApproval, farmingCenter });
  const nftOperatorApprovalData = buildSetApprovalForAllCalldata({ operator: farmingCenter, approved: true });
  const nftTokenApprovalData = buildApproveCalldata({ spender: farmingCenter, amount: tokenId });

  let key = null;
  let rewardTokenMeta = null;
  let bonusRewardTokenMeta = null;
  if (pool) {
    key = await withRpcRetry(() => readEternalFarmingIncentiveKey(pool, { eternalFarming })).catch(() => null);
    if (key && key.rewardToken !== ZERO_ADDRESS) {
      [rewardTokenMeta, bonusRewardTokenMeta] = await Promise.all([
        readTokenSnapshot(key.rewardToken).catch(() => null),
        readTokenSnapshot(key.bonusRewardToken).catch(() => null),
      ]);
    }
  }

  let pendingReward = null;
  let pendingBonusReward = null;
  if (owner && key && key.rewardToken !== ZERO_ADDRESS) {
    [pendingReward, pendingBonusReward] = await Promise.all([
      withRpcRetry(() => readEternalFarmingRewardBalance(owner, key.rewardToken, { eternalFarming })).catch(() => null),
      withRpcRetry(() => readEternalFarmingRewardBalance(owner, key.bonusRewardToken, { eternalFarming })).catch(() => null),
    ]);
  }

  let rewardFlow = null;
  if (
    key
    && key.rewardToken !== ZERO_ADDRESS
    && tokenFarmedIn === farmingCenter
    && depositIncentiveId
    && depositIncentiveId !== ZERO_BYTES32
    && pos.liquidity > 0n
  ) {
    const stableQuoteCtx = createStableQuoteContext();
    const incentiveState = await withRpcRetry(() => readEternalFarmingIncentive(depositIncentiveId, { eternalFarming })).catch(() => null);
    const [virtualPoolState, valueSnap] = await Promise.all([
      incentiveState
        ? withRpcRetry(() => readEternalVirtualPoolRewardState(incentiveState.virtualPoolAddress)).catch(() => null)
        : Promise.resolve(null),
      loadPositionValueSnapshot(tokenId, { ownerAddress: nftOwner, stableQuoteCtx }).catch(() => null),
    ]);

    if (incentiveState && virtualPoolState) {
      const activeAtVirtualTick = (
        virtualPoolState.globalTick >= pos.tickLower
        && virtualPoolState.globalTick < pos.tickUpper
      );
      const currentLiquidity = virtualPoolState.currentLiquidity;
      const canEstimate = activeAtVirtualTick && currentLiquidity > 0n && pos.liquidity > 0n;
      const rewardPerSecRaw = canEstimate ? (virtualPoolState.rewardRate * pos.liquidity) / currentLiquidity : 0n;
      const bonusPerSecRaw = canEstimate ? (virtualPoolState.bonusRewardRate * pos.liquidity) / currentLiquidity : 0n;
      const rewardPerDayRaw = rewardPerSecRaw * 86_400n;
      const bonusPerDayRaw = bonusPerSecRaw * 86_400n;
      const [rewardDayStable, bonusDayStable] = await Promise.all([
        quoteTokenAmountToStable(key.rewardToken, rewardPerDayRaw, { stableQuoteCtx }),
        quoteTokenAmountToStable(key.bonusRewardToken, bonusPerDayRaw, { stableQuoteCtx }),
      ]);
      const rewardValuePerDayStable = (
        Number.isFinite(rewardDayStable.amountOut) || Number.isFinite(bonusDayStable.amountOut)
      ) ? Number(rewardDayStable.amountOut || 0) + Number(bonusDayStable.amountOut || 0) : null;
      const principalStable = valueSnap?.valueInStable?.principal;
      const aprPct = Number.isFinite(rewardValuePerDayStable) && Number.isFinite(principalStable) && principalStable > 0
        ? (rewardValuePerDayStable * 365 * 100) / principalStable
        : null;
      const rewardRunwaySec = virtualPoolState.rewardRate > 0n ? virtualPoolState.rewardReserve / virtualPoolState.rewardRate : null;
      const bonusRunwaySec = virtualPoolState.bonusRewardRate > 0n ? virtualPoolState.bonusRewardReserve / virtualPoolState.bonusRewardRate : null;
      rewardFlow = {
        incentiveState,
        virtualPoolState,
        activeAtVirtualTick,
        rewardPerSecRaw,
        bonusPerSecRaw,
        rewardPerDayRaw,
        bonusPerDayRaw,
        rewardDayStable,
        bonusDayStable,
        rewardValuePerDayStable,
        principalStable,
        aprPct,
        rewardRunwaySec,
        bonusRunwaySec,
      };
    }
  }
  const hasBonusRewardToken = Boolean(
    key
    && key.bonusRewardToken
    && key.bonusRewardToken !== ZERO_ADDRESS
  );
  const bonusRewardRateRaw = rewardFlow?.virtualPoolState?.bonusRewardRate ?? null;
  const bonusRewardEmissionActive = isMeaningfulBigInt(bonusRewardRateRaw);
  const bonusRewardEmissionKnownZero = bonusRewardRateRaw === 0n;
  const rewardMode = describeRewardMode({
    hasBonusRewardToken,
    bonusRewardEmissionActive,
    bonusRewardEmissionKnownZero,
  });
  const stakeState = classifyKittenswapFarmStakeState({
    tokenFarmedIn,
    farmingCenter,
    depositIncentiveId,
  });
  const primaryEmissionActive = isMeaningfulBigInt(rewardFlow?.virtualPoolState?.rewardRate ?? null);

  const lines = [];
  lines.push(`Kittenswap farming status (${tokenId.toString()})`);
  lines.push(`- nft owner: ${nftOwner}`);
  if (owner) {
    lines.push(`- requested owner/sender: ${owner}`);
    lines.push(`- owner matches nft owner: ${owner === nftOwner ? "PASS" : "FAIL"}`);
  }
  lines.push(`- manager: ${KITTENSWAP_CONTRACTS.positionManager}`);
  lines.push(`- farming center (configured): ${farmingCenter}`);
  lines.push(`- eternal farming (configured): ${eternalFarming}`);
  lines.push(`- farming center (position manager): ${managerFarmingCenter || "n/a"}`);
  lines.push(`- manager-center match: ${managerFarmingCenter == null ? "n/a" : managerFarmingCenter === farmingCenter ? "YES" : "NO"}`);
  lines.push(`- position pair: ${pos.token0} / ${pos.token1}`);
  lines.push(`- pool: ${pool || "not found"}`);
  lines.push(`- liquidity: ${pos.liquidity.toString()}`);
  lines.push(`- farming approval for tokenId: ${farmingApproval || "n/a"}`);
  lines.push(`- token farmed in: ${tokenFarmedIn || "n/a"}`);
  lines.push(`- farmingCenter deposit incentiveId: ${depositIncentiveId || "n/a"}`);
  lines.push(`- canonical stake status code: ${stakeState.statusCode}`);
  lines.push(`- staked in configured Kittenswap farm: ${stakeState.stakedInKittenswap ? "YES" : "NO"}`);
  lines.push(`- canonical stake reason: ${stakeState.reason}`);
  lines.push(`- primary KITTEN emission active now: ${primaryEmissionActive ? "YES" : "NO"}`);
  lines.push(`- token approval (getApproved): ${tokenApproval || "n/a"}`);
  lines.push(`- operator approval (isApprovedForAll owner->farmingCenter): ${operatorApproval == null ? "n/a" : operatorApproval ? "true" : "false"}`);
  lines.push(`- token transfer approval to farming center: ${tokenTransferApprovalOk ? "PASS" : "FAIL"}`);

  if (key && key.rewardToken !== ZERO_ADDRESS && key.pool !== ZERO_ADDRESS) {
    lines.push("- active incentive key:");
    lines.push(`  - primaryRewardToken: ${key.rewardToken}${rewardTokenMeta ? ` (${rewardTokenMeta.symbol})` : ""}`);
    if (hasBonusRewardToken) {
      lines.push(`  - secondaryRewardToken (bonus): ${key.bonusRewardToken}${bonusRewardTokenMeta ? ` (${bonusRewardTokenMeta.symbol})` : ""}`);
    } else {
      lines.push("  - secondaryRewardToken (bonus): none");
    }
    lines.push(`  - reward mode: ${rewardMode.code} (${rewardMode.detail})`);
    lines.push(`  - pool: ${key.pool}`);
    lines.push(`  - nonce: ${key.nonce.toString()}`);
  } else {
    lines.push("- active incentive key: none found for this pool");
  }

  if (owner && key && key.rewardToken !== ZERO_ADDRESS) {
    lines.push(`- reward balances for owner ${owner} (claimable via claimReward):`);
    lines.push(`  - primary (${rewardTokenMeta?.symbol || key.rewardToken}): ${pendingReward == null ? "n/a" : formatUnits(pendingReward, rewardTokenMeta?.decimals ?? 18, { precision: 8 })}`);
    if (hasBonusRewardToken) {
      const bonusAmount = pendingBonusReward == null
        ? "n/a"
        : formatUnits(pendingBonusReward, bonusRewardTokenMeta?.decimals ?? 18, { precision: 8 });
      lines.push(`  - secondary (${bonusRewardTokenMeta?.symbol || key.bonusRewardToken}): ${bonusAmount}`);
    }
  } else if (!owner) {
    lines.push("- tip: pass [owner|label] to include reward balance checks");
  }

  if (rewardFlow) {
    const rewardSymbol = rewardTokenMeta?.symbol || key.rewardToken;
    const bonusSymbol = bonusRewardTokenMeta?.symbol || key.bonusRewardToken;
    const stableSymbol = rewardFlow.rewardDayStable?.stableMeta?.symbol || "USD";
    lines.push("- farming reward flow estimate (live):");
    lines.push(`  - virtual pool: ${rewardFlow.incentiveState.virtualPoolAddress}`);
    lines.push(`  - virtual global tick: ${rewardFlow.virtualPoolState.globalTick}`);
    lines.push(`  - position active at virtual tick: ${rewardFlow.activeAtVirtualTick ? "YES" : "NO"}`);
    lines.push(`  - virtual currentLiquidity: ${rewardFlow.virtualPoolState.currentLiquidity.toString()}`);
    lines.push(`  - reward mode: ${rewardMode.code} (${rewardMode.detail})`);
    lines.push(`  - reward rate (pool): ${formatRatePerSecond(rewardFlow.virtualPoolState.rewardRate, rewardTokenMeta?.decimals ?? 18, rewardSymbol)} (${formatRatePerDay(rewardFlow.virtualPoolState.rewardRate, rewardTokenMeta?.decimals ?? 18, rewardSymbol)})`);
    if (hasBonusRewardToken) {
      lines.push(`  - bonus rate (pool): ${formatRatePerSecond(rewardFlow.virtualPoolState.bonusRewardRate, bonusRewardTokenMeta?.decimals ?? 18, bonusSymbol)} (${formatRatePerDay(rewardFlow.virtualPoolState.bonusRewardRate, bonusRewardTokenMeta?.decimals ?? 18, bonusSymbol)})`);
    }
    if (hasBonusRewardToken && bonusRewardEmissionActive) {
      lines.push(`  - est position reward/day: ${formatUnits(rewardFlow.rewardPerDayRaw, rewardTokenMeta?.decimals ?? 18, { precision: 8 })} ${rewardSymbol} + ${formatUnits(rewardFlow.bonusPerDayRaw, bonusRewardTokenMeta?.decimals ?? 18, { precision: 8 })} ${bonusSymbol}`);
    } else {
      lines.push(`  - est position reward/day: ${formatUnits(rewardFlow.rewardPerDayRaw, rewardTokenMeta?.decimals ?? 18, { precision: 8 })} ${rewardSymbol}`);
    }
    lines.push(`  - est reward value/day (${stableSymbol}): ${rewardFlow.rewardValuePerDayStable == null ? "n/a" : fmtNum(rewardFlow.rewardValuePerDayStable, { dp: 6 })}`);
    lines.push(`  - est APR on principal (${stableSymbol}): ${rewardFlow.aprPct == null ? "n/a" : fmtPct(rewardFlow.aprPct)}`);
    lines.push(`  - reward reserve runway: ${rewardFlow.rewardRunwaySec == null ? "n/a" : formatDurationSeconds(rewardFlow.rewardRunwaySec)}`);
    if (hasBonusRewardToken) {
      lines.push(`  - bonus reserve runway: ${rewardFlow.bonusRunwaySec == null ? "n/a" : formatDurationSeconds(rewardFlow.bonusRunwaySec)}`);
    }
    lines.push("  - note: APR is an estimate from current reward rates, current virtual liquidity, and live quote marks; it changes with pool activity.");
  }

  lines.push("- next steps:");
  lines.push("  - required token transfer permission for farming center: setApprovalForAll(farmingCenter,true) OR approve(tokenId,farmingCenter) on position manager");
  lines.push("  - required approval call is approveForFarming(tokenId, true, farmingCenter) on position manager");
  lines.push("  - setApprovalForAll alone does NOT set farmingApprovals(tokenId)");
  lines.push("  - approveForFarming alone does NOT grant NFT transfer approval (needed to avoid 'Not approved for token')");
  lines.push("  - if farming approval != farming center: run krlp farm-approve-plan <tokenId>");
  lines.push("  - if token transfer approval FAIL: submit ERC721 approval tx to position manager, then retry farm-enter-plan");
  if (!tokenTransferApprovalOk) {
    lines.push("  - ERC721 approval calldata templates:");
    lines.push(`    - setApprovalForAll data: ${nftOperatorApprovalData}`);
    lines.push(`    - approve(tokenId) data: ${nftTokenApprovalData}`);
  }
  lines.push("  - then run krlp farm-enter-plan <tokenId> --auto-key");
  if (hasBonusRewardToken && !bonusRewardEmissionActive) {
    lines.push("  - reward collection mode now: claim primary reward token by default.");
  }
  lines.push("  - after earning rewards: run krlp farm-collect-plan <tokenId> --auto-key and krlp farm-claim-plan <rewardToken> --amount max");
  return lines.join("\n");
}

async function cmdFarmApprovePlan({
  tokenIdRaw,
  ownerRef = "",
  farmingCenterRef = "",
  eternalFarmingRef = "",
  approve = true,
}) {
  const tokenId = parseTokenId(tokenIdRaw);
  const owner = await resolveAddressInput(ownerRef || "", { allowDefault: true });
  const { farmingCenter, managerFarmingCenter } = await resolveFarmingContracts({
    farmingCenterRef,
    eternalFarmingRef,
  });
  const [nftOwner, farmingApproval, tokenFarmedIn, tokenApproval] = await Promise.all([
    withRpcRetry(() => readOwnerOf(tokenId, { positionManager: KITTENSWAP_CONTRACTS.positionManager })).catch(() => null),
    withRpcRetry(() => readPositionFarmingApproval(tokenId, { positionManager: KITTENSWAP_CONTRACTS.positionManager })).catch(() => null),
    withRpcRetry(() => readTokenFarmedIn(tokenId, { positionManager: KITTENSWAP_CONTRACTS.positionManager })).catch(() => null),
    withRpcRetry(() => readPositionManagerTokenApproval(tokenId, { positionManager: KITTENSWAP_CONTRACTS.positionManager })).catch(() => null),
  ]);
  const operatorApproval = await withRpcRetry(
    () => readPositionManagerIsApprovedForAll(nftOwner || owner, farmingCenter, { positionManager: KITTENSWAP_CONTRACTS.positionManager })
  ).catch(() => null);
  const tokenTransferApprovalOk = hasFarmingTokenTransferApproval({ tokenApproval, operatorApproved: operatorApproval, farmingCenter });

  const data = buildApproveForFarmingCalldata({
    tokenId,
    approve: parseBoolFlag(approve),
    farmingAddress: farmingCenter,
  });
  const gas = await estimateCallGas({
    from: owner,
    to: KITTENSWAP_CONTRACTS.positionManager,
    data,
    value: 0n,
  });
  const sim = await replayEthCall({
    fromAddress: owner,
    toAddress: KITTENSWAP_CONTRACTS.positionManager,
    data,
    value: 0n,
    blockTag: "latest",
  });
  const simLabel = sim.ok
    ? "PASS"
    : sim.category === "rpc_unavailable"
      ? "UNAVAILABLE (RPC timeout/rate-limit)"
      : sim.category === "insufficient_native_balance_for_replay"
        ? "SKIPPED (insufficient native balance for replay)"
        : `REVERT${sim.revertHint ? ` (${sim.revertHint})` : ""}`;

  const lines = [];
  lines.push("Kittenswap farm approval plan");
  lines.push(`- owner: ${owner}`);
  lines.push(`- nft owner: ${nftOwner || "n/a"}`);
  if (nftOwner) lines.push(`- owner matches nft owner: ${owner === nftOwner ? "PASS" : "FAIL"}`);
  lines.push(`- tokenId: ${tokenId.toString()}`);
  lines.push(`- position manager: ${KITTENSWAP_CONTRACTS.positionManager}`);
  lines.push("- function: approveForFarming(uint256,bool,address) selector=0x832f630a");
  lines.push(`- target farming center: ${farmingCenter}`);
  lines.push(`- position manager farming center: ${managerFarmingCenter || "n/a"}`);
  lines.push(`- current farming approval: ${farmingApproval || "n/a"}`);
  lines.push(`- current token farmed in: ${tokenFarmedIn || "n/a"}`);
  lines.push(`- token approval (getApproved): ${tokenApproval || "n/a"}`);
  lines.push(`- operator approval (isApprovedForAll owner->farmingCenter): ${operatorApproval == null ? "n/a" : operatorApproval ? "true" : "false"}`);
  lines.push(`- token transfer approval to farming center: ${tokenTransferApprovalOk ? "PASS" : "FAIL"}`);
  lines.push(`- direct approveForFarming eth_call simulation: ${simLabel}`);
  if (!sim.ok && sim.error) lines.push(`- direct approveForFarming simulation error: ${sim.error}`);
  if (managerFarmingCenter && managerFarmingCenter !== farmingCenter) {
    lines.push("- BLOCKER: provided farming center differs from position manager configured center.");
  }
  if (nftOwner && owner !== nftOwner) {
    lines.push("- BLOCKER: sender is not nft owner; approval call is expected to revert.");
  }
  lines.push("- transaction template (full calldata):");
  lines.push(`  - to: ${KITTENSWAP_CONTRACTS.positionManager}`);
  lines.push(`  - value: ${toHexQuantity(0n)} (0 HYPE)`);
  lines.push(`  - data: ${data}`);
  if (gas.ok) lines.push(`  - gas est: ${gas.gas.toString()} (${gas.gasHex})`);
  else lines.push(`  - gas est: unavailable (${gas.error})`);
  lines.push("- safety:");
  lines.push("  - this command is dry-run only and does not sign/broadcast");
  lines.push("  - do not substitute setApprovalForAll for this step; farm-enter checks farmingApprovals(tokenId)");
  lines.push("  - approveForFarming does not grant NFT transfer permission; farm-enter also requires setApprovalForAll or token-level approve");
  lines.push("  - farm-enter requires this approval to match farming center");
  return lines.join("\n");
}

async function cmdFarmEnterPlan({
  tokenIdRaw,
  ownerRef = "",
  rewardTokenRef = "",
  bonusRewardTokenRef = "",
  poolRef = "",
  nonceRef = "",
  autoKey = false,
  farmingCenterRef = "",
  eternalFarmingRef = "",
}) {
  const tokenId = parseTokenId(tokenIdRaw);
  const owner = await resolveAddressInput(ownerRef || "", { allowDefault: true });
  const { farmingCenter, eternalFarming, managerFarmingCenter } = await resolveFarmingContracts({
    farmingCenterRef,
    eternalFarmingRef,
  });
  const [{ key, source }, nftOwner, farmingApproval, tokenFarmedIn, tokenApproval] = await Promise.all([
    resolveIncentiveKey({
      tokenId,
      rewardTokenRef,
      bonusRewardTokenRef,
      poolRef,
      nonceRef,
      autoKey: parseBoolFlag(autoKey),
      eternalFarmingAddress: eternalFarming,
    }),
    withRpcRetry(() => readOwnerOf(tokenId, { positionManager: KITTENSWAP_CONTRACTS.positionManager })),
    withRpcRetry(() => readPositionFarmingApproval(tokenId, { positionManager: KITTENSWAP_CONTRACTS.positionManager })).catch(() => null),
    withRpcRetry(() => readTokenFarmedIn(tokenId, { positionManager: KITTENSWAP_CONTRACTS.positionManager })).catch(() => null),
    withRpcRetry(() => readPositionManagerTokenApproval(tokenId, { positionManager: KITTENSWAP_CONTRACTS.positionManager })).catch(() => null),
  ]);
  const operatorApproval = await withRpcRetry(
    () => readPositionManagerIsApprovedForAll(nftOwner, farmingCenter, { positionManager: KITTENSWAP_CONTRACTS.positionManager })
  ).catch(() => null);
  const tokenTransferApprovalOk = hasFarmingTokenTransferApproval({ tokenApproval, operatorApproved: operatorApproval, farmingCenter });
  const [rewardMeta, bonusMeta] = await Promise.all([
    readTokenSnapshot(key.rewardToken).catch(() => null),
    readTokenSnapshot(key.bonusRewardToken).catch(() => null),
  ]);

  const data = buildFarmingEnterCalldata({ ...key, tokenId });
  const gas = await estimateCallGas({ from: owner, to: farmingCenter, data, value: 0n });
  const nftOperatorApprovalData = buildSetApprovalForAllCalldata({ operator: farmingCenter, approved: true });
  const nftTokenApprovalData = buildApproveCalldata({ spender: farmingCenter, amount: tokenId });
  const [nftOperatorApprovalGas, nftTokenApprovalGas] = await Promise.all([
    estimateCallGas({
      from: owner,
      to: KITTENSWAP_CONTRACTS.positionManager,
      data: nftOperatorApprovalData,
      value: 0n,
    }),
    estimateCallGas({
      from: owner,
      to: KITTENSWAP_CONTRACTS.positionManager,
      data: nftTokenApprovalData,
      value: 0n,
    }),
  ]);
  const sim = await replayEthCall({
    fromAddress: owner,
    toAddress: farmingCenter,
    data,
    value: 0n,
    blockTag: "latest",
  });
  const simLabel = sim.ok
    ? "PASS"
    : sim.category === "rpc_unavailable"
      ? "UNAVAILABLE (RPC timeout/rate-limit)"
      : sim.category === "insufficient_native_balance_for_replay"
        ? "SKIPPED (insufficient native balance for replay)"
        : `REVERT${sim.revertHint ? ` (${sim.revertHint})` : ""}`;

  const lines = [];
  lines.push("Kittenswap farm enter plan");
  lines.push(`- owner: ${owner}`);
  lines.push(`- nft owner: ${nftOwner}`);
  lines.push(`- tokenId: ${tokenId.toString()}`);
  lines.push(`- farming center: ${farmingCenter}`);
  lines.push(`- position manager farming center: ${managerFarmingCenter || "n/a"}`);
  lines.push(`- key source: ${source}`);
  lines.push(`- incentive reward token: ${key.rewardToken}${rewardMeta ? ` (${rewardMeta.symbol})` : ""}`);
  lines.push(`- incentive bonus token: ${key.bonusRewardToken}${bonusMeta ? ` (${bonusMeta.symbol})` : ""}`);
  lines.push(`- incentive pool: ${key.pool}`);
  lines.push(`- incentive nonce: ${key.nonce.toString()}`);
  lines.push(`- current farming approval: ${farmingApproval || "n/a"}`);
  lines.push(`- token currently farmed in: ${tokenFarmedIn || "n/a"}`);
  lines.push(`- token approval (getApproved): ${tokenApproval || "n/a"}`);
  lines.push(`- operator approval (isApprovedForAll owner->farmingCenter): ${operatorApproval == null ? "n/a" : operatorApproval ? "true" : "false"}`);
  lines.push(`- preflight token transfer approval to farming center: ${tokenTransferApprovalOk ? "PASS" : "FAIL"}`);
  lines.push(`- preflight approval matches farming center: ${farmingApproval === farmingCenter ? "PASS" : "FAIL"}`);
  lines.push(`- direct enterFarming eth_call simulation: ${simLabel}`);
  if (!sim.ok && sim.error) lines.push(`- direct enterFarming simulation error: ${sim.error}`);
  if (owner !== nftOwner) {
    lines.push("- BLOCKER: sender is not nft owner; farming actions are expected to revert.");
  }
  if (!tokenTransferApprovalOk) {
    lines.push(`- BLOCKER: tokenId ${tokenId.toString()} is missing NFT transfer approval to farming center ${farmingCenter}.`);
    lines.push("- note: after farmingApprovals is set, this missing approval can revert with 'Not approved for token'.");
    lines.push("- fix: submit ERC721 approval on position manager from nft owner using setApprovalForAll(farmingCenter,true) or approve(tokenId,farmingCenter).");
    lines.push("- approval transaction templates (choose one):");
    lines.push("  - recommended (operator-wide):");
    lines.push(`    - to: ${KITTENSWAP_CONTRACTS.positionManager}`);
    lines.push(`    - value: ${toHexQuantity(0n)} (0 HYPE)`);
    lines.push(`    - data: ${nftOperatorApprovalData}`);
    if (nftOperatorApprovalGas.ok) lines.push(`    - gas est: ${nftOperatorApprovalGas.gas.toString()} (${nftOperatorApprovalGas.gasHex})`);
    else lines.push(`    - gas est: unavailable (${nftOperatorApprovalGas.error})`);
    lines.push("  - token-specific (single tokenId):");
    lines.push(`    - to: ${KITTENSWAP_CONTRACTS.positionManager}`);
    lines.push(`    - value: ${toHexQuantity(0n)} (0 HYPE)`);
    lines.push(`    - data: ${nftTokenApprovalData}`);
    if (nftTokenApprovalGas.ok) lines.push(`    - gas est: ${nftTokenApprovalGas.gas.toString()} (${nftTokenApprovalGas.gasHex})`);
    else lines.push(`    - gas est: unavailable (${nftTokenApprovalGas.error})`);
    lines.push("  - after approval tx is mined, re-run farm-status and require token transfer approval = PASS.");
  }
  if (farmingApproval !== farmingCenter) {
    lines.push(`- BLOCKER: tokenId ${tokenId.toString()} is not approved for farming center ${farmingCenter}. Run farm-approve-plan first.`);
    lines.push("- note: setApprovalForAll does not satisfy this check; approveForFarming(tokenId,true,farmingCenter) is required.");
  }
  if (tokenFarmedIn && tokenFarmedIn !== ZERO_ADDRESS) {
    lines.push(`- BLOCKER: tokenId is already farmed in ${tokenFarmedIn}. Exit first if you need to move.`);
  }
  lines.push("- transaction template (full calldata):");
  lines.push(`  - to: ${farmingCenter}`);
  lines.push(`  - value: ${toHexQuantity(0n)} (0 HYPE)`);
  lines.push(`  - data: ${data}`);
  if (gas.ok) lines.push(`  - gas est: ${gas.gas.toString()} (${gas.gasHex})`);
  else lines.push(`  - gas est: unavailable (${gas.error})`);
  lines.push("- safety:");
  lines.push("  - this command is dry-run only and does not sign/broadcast");
  lines.push("  - use --auto-key when possible to avoid manual key mismatches");
  return lines.join("\n");
}

async function cmdFarmExitPlan({
  tokenIdRaw,
  ownerRef = "",
  rewardTokenRef = "",
  bonusRewardTokenRef = "",
  poolRef = "",
  nonceRef = "",
  autoKey = false,
  farmingCenterRef = "",
  eternalFarmingRef = "",
}) {
  const tokenId = parseTokenId(tokenIdRaw);
  const owner = await resolveAddressInput(ownerRef || "", { allowDefault: true });
  const { farmingCenter, eternalFarming } = await resolveFarmingContracts({
    farmingCenterRef,
    eternalFarmingRef,
  });
  const [{
    key,
    source,
    depositIncentiveId = null,
    keyIncentiveId = null,
    keyMatchesDeposit = null,
    sourceTxHash = null,
  }, tokenFarmedIn] = await Promise.all([
    resolveIncentiveKey({
      tokenId,
      rewardTokenRef,
      bonusRewardTokenRef,
      poolRef,
      nonceRef,
      autoKey: parseBoolFlag(autoKey),
      matchDepositIncentive: true,
      ownerAddress: owner,
      farmingCenterAddress: farmingCenter,
      eternalFarmingAddress: eternalFarming,
    }),
    withRpcRetry(() => readTokenFarmedIn(tokenId, { positionManager: KITTENSWAP_CONTRACTS.positionManager })).catch(() => null),
  ]);

  const data = buildFarmingExitCalldata({ ...key, tokenId });
  const [gas, sim] = await Promise.all([
    estimateCallGas({ from: owner, to: farmingCenter, data, value: 0n }),
    replayEthCall({
      fromAddress: owner,
      toAddress: farmingCenter,
      data,
      value: 0n,
      blockTag: "latest",
    }),
  ]);
  const simLabel = sim.ok
    ? "PASS"
    : sim.category === "rpc_unavailable"
      ? "UNAVAILABLE (RPC timeout/rate-limit)"
      : sim.category === "insufficient_native_balance_for_replay"
        ? "SKIPPED (insufficient native balance for replay)"
        : `REVERT${sim.revertHint ? ` (${sim.revertHint})` : ""}`;

  const lines = [];
  lines.push("Kittenswap farm exit plan");
  lines.push(`- owner: ${owner}`);
  lines.push(`- tokenId: ${tokenId.toString()}`);
  lines.push(`- farming center: ${farmingCenter}`);
  lines.push(`- key source: ${source}`);
  lines.push(`- token currently farmed in: ${tokenFarmedIn || "n/a"}`);
  lines.push(`- incentive pool: ${key.pool}`);
  lines.push(`- incentive nonce: ${key.nonce.toString()}`);
  if (depositIncentiveId) lines.push(`- farmingCenter deposit incentiveId: ${depositIncentiveId}`);
  if (keyIncentiveId) lines.push(`- selected key incentiveId: ${keyIncentiveId}`);
  if (keyMatchesDeposit != null) lines.push(`- selected key matches deposit incentiveId: ${keyMatchesDeposit ? "PASS" : "FAIL"}`);
  if (sourceTxHash) lines.push(`- key source tx: ${sourceTxHash}`);
  lines.push(`- direct exitFarming eth_call simulation: ${simLabel}`);
  if (!sim.ok && sim.error) lines.push(`- direct exitFarming simulation error: ${sim.error}`);
  if (!tokenFarmedIn || tokenFarmedIn === ZERO_ADDRESS) {
    lines.push("- warning: token does not appear farmed right now.");
  }
  if (keyMatchesDeposit === false) {
    lines.push("- BLOCKER: selected incentive key does not match token deposit incentiveId.");
  }
  if (!sim.ok) {
    if (sim.category === "rpc_unavailable") {
      lines.push("- BLOCKER: preflight simulation is unavailable due RPC instability; re-run until simulation is PASS before signing.");
    } else {
      lines.push("- BLOCKER: direct exitFarming simulation reverted; do not sign/send this tx.");
    }
  }
  lines.push("- transaction template (full calldata):");
  lines.push(`  - to: ${farmingCenter}`);
  lines.push(`  - value: ${toHexQuantity(0n)} (0 HYPE)`);
  lines.push(`  - data: ${data}`);
  if (gas.ok) lines.push(`  - gas est: ${gas.gas.toString()} (${gas.gasHex})`);
  else lines.push(`  - gas est: unavailable (${gas.error})`);
  lines.push("- safety:");
  lines.push("  - this command is dry-run only and does not sign/broadcast");
  return lines.join("\n");
}

async function cmdFarmCollectPlan({
  tokenIdRaw,
  ownerRef = "",
  rewardTokenRef = "",
  bonusRewardTokenRef = "",
  poolRef = "",
  nonceRef = "",
  autoKey = false,
  farmingCenterRef = "",
  eternalFarmingRef = "",
}) {
  const tokenId = parseTokenId(tokenIdRaw);
  const owner = await resolveAddressInput(ownerRef || "", { allowDefault: true });
  const { farmingCenter, eternalFarming } = await resolveFarmingContracts({
    farmingCenterRef,
    eternalFarmingRef,
  });
  const {
    key,
    source,
    depositIncentiveId = null,
    keyIncentiveId = null,
    keyMatchesDeposit = null,
    sourceTxHash = null,
  } = await resolveIncentiveKey({
    tokenId,
    rewardTokenRef,
    bonusRewardTokenRef,
    poolRef,
    nonceRef,
    autoKey: parseBoolFlag(autoKey),
    matchDepositIncentive: true,
    ownerAddress: owner,
    farmingCenterAddress: farmingCenter,
    eternalFarmingAddress: eternalFarming,
  });
  const data = buildFarmingCollectRewardsCalldata({ ...key, tokenId });
  const [tokenFarmedIn, gas, sim] = await Promise.all([
    withRpcRetry(() => readTokenFarmedIn(tokenId, { positionManager: KITTENSWAP_CONTRACTS.positionManager })).catch(() => null),
    estimateCallGas({ from: owner, to: farmingCenter, data, value: 0n }),
    replayEthCall({
      fromAddress: owner,
      toAddress: farmingCenter,
      data,
      value: 0n,
      blockTag: "latest",
    }),
  ]);
  const simLabel = sim.ok
    ? "PASS"
    : sim.category === "rpc_unavailable"
      ? "UNAVAILABLE (RPC timeout/rate-limit)"
      : sim.category === "insufficient_native_balance_for_replay"
        ? "SKIPPED (insufficient native balance for replay)"
        : `REVERT${sim.revertHint ? ` (${sim.revertHint})` : ""}`;

  const lines = [];
  lines.push("Kittenswap farm collect-rewards plan");
  lines.push(`- owner: ${owner}`);
  lines.push(`- tokenId: ${tokenId.toString()}`);
  lines.push(`- farming center: ${farmingCenter}`);
  lines.push(`- key source: ${source}`);
  lines.push(`- token currently farmed in: ${tokenFarmedIn || "n/a"}`);
  lines.push(`- incentive pool: ${key.pool}`);
  lines.push(`- incentive nonce: ${key.nonce.toString()}`);
  if (depositIncentiveId) lines.push(`- farmingCenter deposit incentiveId: ${depositIncentiveId}`);
  if (keyIncentiveId) lines.push(`- selected key incentiveId: ${keyIncentiveId}`);
  if (keyMatchesDeposit != null) lines.push(`- selected key matches deposit incentiveId: ${keyMatchesDeposit ? "PASS" : "FAIL"}`);
  if (sourceTxHash) lines.push(`- key source tx: ${sourceTxHash}`);
  lines.push(`- direct collectRewards eth_call simulation: ${simLabel}`);
  if (!sim.ok && sim.error) lines.push(`- direct collectRewards simulation error: ${sim.error}`);
  if (tokenFarmedIn === ZERO_ADDRESS) {
    lines.push("- warning: token is not currently staked; collectRewards may revert.");
  }
  if (keyMatchesDeposit === false) {
    lines.push("- BLOCKER: selected incentive key does not match token deposit incentiveId.");
  }
  if (!sim.ok) {
    if (sim.category === "rpc_unavailable") {
      lines.push("- BLOCKER: preflight simulation is unavailable due RPC instability; re-run until simulation is PASS before signing.");
    } else {
      lines.push("- BLOCKER: direct collectRewards simulation reverted; do not sign/send this tx.");
    }
  }
  lines.push("- transaction template (full calldata):");
  lines.push(`  - to: ${farmingCenter}`);
  lines.push(`  - value: ${toHexQuantity(0n)} (0 HYPE)`);
  lines.push(`  - data: ${data}`);
  if (gas.ok) lines.push(`  - gas est: ${gas.gas.toString()} (${gas.gasHex})`);
  else lines.push(`  - gas est: unavailable (${gas.error})`);
  lines.push("- note: collectRewards accrues rewards internally; claimReward moves tokens to wallet.");
  lines.push("- safety:");
  lines.push("  - this command is dry-run only and does not sign/broadcast");
  return lines.join("\n");
}

async function cmdFarmClaimPlan({
  rewardTokenRef,
  ownerRef = "",
  toRef = "",
  amountRef = "max",
  farmingCenterRef = "",
  eternalFarmingRef = "",
}) {
  const owner = await resolveAddressInput(ownerRef || "", { allowDefault: true });
  const to = toRef ? await resolveAddressInput(toRef, { allowDefault: false }) : owner;
  const rewardToken = assertAddress(rewardTokenRef);
  const { farmingCenter, eternalFarming } = await resolveFarmingContracts({
    farmingCenterRef,
    eternalFarmingRef,
  });
  const tokenMeta = await readTokenSnapshot(rewardToken).catch(() => null);
  const pendingBalance = await withRpcRetry(() => readEternalFarmingRewardBalance(owner, rewardToken, { eternalFarming })).catch(() => null);

  const useMax = String(amountRef || "").toLowerCase() === "max";
  const amountRequested = useMax ? maxUint256() : parseDecimalToUnits(String(amountRef), tokenMeta?.decimals ?? 18);
  const data = buildFarmingClaimRewardCalldata({ rewardToken, to, amountRequested });
  const [gas, sim] = await Promise.all([
    estimateCallGas({ from: owner, to: farmingCenter, data, value: 0n }),
    replayEthCall({
      fromAddress: owner,
      toAddress: farmingCenter,
      data,
      value: 0n,
      blockTag: "latest",
    }),
  ]);
  const simLabel = sim.ok
    ? "PASS"
    : sim.category === "rpc_unavailable"
      ? "UNAVAILABLE (RPC timeout/rate-limit)"
      : sim.category === "insufficient_native_balance_for_replay"
        ? "SKIPPED (insufficient native balance for replay)"
        : `REVERT${sim.revertHint ? ` (${sim.revertHint})` : ""}`;

  const lines = [];
  lines.push("Kittenswap farm claim-reward plan");
  lines.push(`- owner: ${owner}`);
  lines.push(`- recipient: ${to}`);
  lines.push(`- farming center: ${farmingCenter}`);
  lines.push(`- reward token: ${rewardToken}${tokenMeta ? ` (${tokenMeta.symbol})` : ""}`);
  lines.push(`- pending reward balance (farming contract): ${pendingBalance == null ? "n/a" : formatUnits(pendingBalance, tokenMeta?.decimals ?? 18, { precision: 8 })}${tokenMeta ? ` ${tokenMeta.symbol}` : ""}`);
  lines.push(`- amount requested: ${useMax ? "MAX_UINT256 (claim all available)" : `${formatUnits(amountRequested, tokenMeta?.decimals ?? 18, { precision: 8 })}${tokenMeta ? ` ${tokenMeta.symbol}` : ""}`}`);
  lines.push(`- direct claimReward eth_call simulation: ${simLabel}`);
  if (!sim.ok && sim.error) lines.push(`- direct claimReward simulation error: ${sim.error}`);
  if (pendingBalance === 0n) {
    lines.push("- note: pending balance is currently 0; claim may be a no-op.");
  }
  if (!sim.ok) {
    if (sim.category === "rpc_unavailable") {
      lines.push("- BLOCKER: preflight simulation is unavailable due RPC instability; re-run until simulation is PASS before signing.");
    } else {
      lines.push("- BLOCKER: direct claimReward simulation reverted; do not sign/send this tx.");
    }
  }
  lines.push("- transaction template (full calldata):");
  lines.push(`  - to: ${farmingCenter}`);
  lines.push(`  - value: ${toHexQuantity(0n)} (0 HYPE)`);
  lines.push(`  - data: ${data}`);
  if (gas.ok) lines.push(`  - gas est: ${gas.gas.toString()} (${gas.gasHex})`);
  else lines.push(`  - gas est: unavailable (${gas.error})`);
  lines.push("- safety:");
  lines.push("  - this command is dry-run only and does not sign/broadcast");
  return lines.join("\n");
}

async function cmdQuoteSwap({ tokenInRef, tokenOutRef, deployerRef, amountInDecimal }) {
  const tokenIn = resolveTokenAddressInput(tokenInRef, { field: "tokenIn" });
  const tokenOut = resolveTokenAddressInput(tokenOutRef, { field: "tokenOut" });
  const deployer = assertAddress(deployerRef);

  const [inMeta, outMeta] = await Promise.all([
    withRpcRetry(() => readTokenSnapshot(tokenIn)),
    withRpcRetry(() => readTokenSnapshot(tokenOut)),
  ]);

  const amountIn = parseDecimalToUnits(amountInDecimal, inMeta.decimals);
  if (amountIn <= 0n) throw new Error("amount-in must be > 0");

  const q = await withRpcRetry(() => quoteExactInputSingle({
    tokenIn,
    tokenOut,
    deployer,
    amountIn,
    limitSqrtPrice: 0n,
  }));

  const lines = [];
  lines.push("Kittenswap quoteExactInputSingle");
  lines.push(`- token in: ${inMeta.symbol} (${tokenIn})`);
  lines.push(`- token out: ${outMeta.symbol} (${tokenOut})`);
  lines.push(`- deployer: ${deployer}`);
  lines.push(`- amount in: ${formatUnits(amountIn, inMeta.decimals, { precision: 8 })} ${inMeta.symbol}`);
  lines.push(`- quoted amount out: ${formatUnits(q.amountOut, outMeta.decimals, { precision: 8 })} ${outMeta.symbol}`);
  lines.push(`- fee tier: ${q.fee}`);
  lines.push(`- initialized ticks crossed: ${q.initializedTicksCrossed}`);
  lines.push(`- gas estimate (quoter): ${q.gasEstimate.toString()}`);
  return lines.join("\n");
}

async function cmdSwapApprovePlan({ tokenRef, ownerRef, amountRef, spenderRef, approveMax }) {
  const token = resolveTokenAddressInput(tokenRef, { field: "token" });
  const owner = await resolveAddressInput(ownerRef || "", { allowDefault: true });
  const spender = spenderRef ? await resolveAddressInput(spenderRef, { allowDefault: false }) : KITTENSWAP_CONTRACTS.router;

  const tokenMeta = await withRpcRetry(() => readTokenSnapshot(token, owner));
  const currentAllowance = await withRpcRetry(() => readErc20Allowance(token, owner, spender)).catch(() => null);

  const useMax = parseBoolFlag(approveMax) || String(amountRef || "").toLowerCase() === "max";
  const approveAmount = useMax ? maxUint256() : parseDecimalToUnits(String(amountRef), tokenMeta.decimals);
  if (approveAmount <= 0n) throw new Error("approve amount must be > 0");

  const data = buildApproveCalldata({ spender, amount: approveAmount });
  const gas = await estimateCallGas({ from: owner, to: token, data, value: 0n });
  const gasPriceHex = await withRpcRetry(() => rpcGasPrice()).catch(() => null);
  const gasPriceWei = gasPriceHex ? BigInt(gasPriceHex) : null;
  const estFeeWei = gas.ok && gasPriceWei != null ? gas.gas * gasPriceWei : null;

  const lines = [];
  lines.push("Kittenswap swap approve plan");
  lines.push(`- owner: ${owner}`);
  lines.push(`- token: ${tokenMeta.symbol} (${tokenMeta.address})`);
  lines.push(`- spender: ${spender}`);
  lines.push(`- current allowance: ${currentAllowance == null ? "n/a" : `${formatUnits(currentAllowance, tokenMeta.decimals, { precision: 8 })} ${tokenMeta.symbol}`}`);
  lines.push(`- wallet balance: ${tokenMeta.balance == null ? "n/a" : `${formatUnits(tokenMeta.balance, tokenMeta.decimals, { precision: 8 })} ${tokenMeta.symbol}`}`);
  lines.push(`- approval amount: ${useMax ? "MAX_UINT256" : `${formatUnits(approveAmount, tokenMeta.decimals, { precision: 8 })} ${tokenMeta.symbol}`}`);
  lines.push("- transaction template (full calldata):");
  lines.push(`  - to: ${tokenMeta.address}`);
  lines.push(`  - value: ${toHexQuantity(0n)} (0 HYPE)`);
  lines.push(`  - data: ${data}`);
  if (gas.ok) lines.push(`  - gas est: ${gas.gas.toString()} (${gas.gasHex})`);
  else lines.push(`  - gas est: unavailable (${gas.error})`);
  if (estFeeWei != null) {
    lines.push(`- gas price: ${formatUnits(gasPriceWei, 9, { precision: 3 })} gwei`);
    lines.push(`- est fee: ${formatUnits(estFeeWei, 18, { precision: 8 })} HYPE`);
  }
  lines.push("- safety:");
  lines.push("  - output uses full addresses and full calldata; do not truncate or reconstruct");
  lines.push("  - this command is dry-run only and does not sign/broadcast");
  lines.push("  - use exact approval amounts when possible; use MAX only if intentional");
  return lines.join("\n");
}

async function cmdSwapPlan({
  tokenInRef,
  tokenOutRef,
  deployerRef,
  amountInDecimal,
  ownerRef,
  recipientRef,
  policyRef,
  slippageBps,
  deadlineSeconds,
  limitSqrtPriceRef,
  nativeIn,
  approveMax,
}) {
  const tokenIn = resolveTokenAddressInput(tokenInRef, { field: "tokenIn" });
  const tokenOut = resolveTokenAddressInput(tokenOutRef, { field: "tokenOut" });
  if (tokenIn === tokenOut) throw new Error("tokenIn and tokenOut must differ");

  const deployer = assertAddress(deployerRef);
  const owner = await resolveAddressInput(ownerRef || "", { allowDefault: true });
  const recipient = recipientRef ? await resolveAddressInput(recipientRef, { allowDefault: false }) : owner;

  const policyLoaded = await getPolicy(policyRef || "");
  const effSlipBps = parseBps(slippageBps, policyLoaded.policy.slippageBps, { min: 0, max: 10_000 });
  const effDeadlineSec = parseSeconds(deadlineSeconds, policyLoaded.policy.deadlineSeconds, { min: 1, max: 86_400 });
  const limitSqrtPrice = parseOptionalUint(limitSqrtPriceRef, 0n);

  const [tokenInMeta, tokenOutMeta] = await Promise.all([
    withRpcRetry(() => readTokenSnapshot(tokenIn, owner)),
    withRpcRetry(() => readTokenSnapshot(tokenOut, owner)),
  ]);

  const amountIn = parseDecimalToUnits(String(amountInDecimal), tokenInMeta.decimals);
  if (amountIn <= 0n) throw new Error("amount-in must be > 0");

  const useNativeIn = parseBoolFlag(nativeIn);
  let routerWNative = null;
  if (useNativeIn) {
    routerWNative = await readRouterWNativeToken();
    if (tokenIn !== routerWNative) {
      throw new Error(`--native-in requires tokenIn == router WNativeToken (${routerWNative})`);
    }
  }

  const quote = await withRpcRetry(() => quoteExactInputSingle({
    tokenIn,
    tokenOut,
    deployer,
    amountIn,
    limitSqrtPrice,
  }));
  const amountOutMin = (quote.amountOut * BigInt(10_000 - effSlipBps)) / 10_000n;

  const latestBlock = await rpcGetBlockByNumber("latest", false).catch(() => null);
  const planBlockNumber = latestBlock?.number ? Number.parseInt(latestBlock.number, 16) : null;
  const nowTs = latestBlock?.timestamp ? Number(BigInt(latestBlock.timestamp)) : Math.floor(Date.now() / 1000);
  const deadline = BigInt(nowTs + effDeadlineSec);
  const deadlineIso = new Date((nowTs + effDeadlineSec) * 1000).toISOString();
  const deadlineHeadroomSec = effDeadlineSec;

  const allowanceCheck = useNativeIn
    ? null
    : await withRpcRetry(() => readErc20Allowance(tokenIn, owner, KITTENSWAP_CONTRACTS.router))
      .then((value) => ({ ok: true, value, error: null }))
      .catch((e) => ({ ok: false, value: null, error: e?.message || String(e) }));
  const allowance = allowanceCheck?.value ?? null;
  const needsApproval = !useNativeIn && (!allowanceCheck?.ok || allowance < amountIn);
  const approveAmount = parseBoolFlag(approveMax) ? maxUint256() : amountIn;
  const insufficientTokenInBalance = !useNativeIn && tokenInMeta.balance != null && tokenInMeta.balance < amountIn;
  const insufficientAllowance = !useNativeIn && allowanceCheck?.ok && allowance < amountIn;

  const swapData = buildSwapExactInputSingleCalldata({
    tokenIn,
    tokenOut,
    deployer,
    recipient,
    deadline,
    amountIn,
    amountOutMinimum: amountOutMin,
    limitSqrtPrice,
  });

  const swapValue = useNativeIn ? amountIn : 0n;
  const calls = [];
  if (needsApproval) {
    calls.push({
      step: "approve_token_in",
      to: tokenIn,
      value: 0n,
      data: buildApproveCalldata({ spender: KITTENSWAP_CONTRACTS.router, amount: approveAmount }),
    });
  }
  calls.push({
    step: "swap_exact_input_single",
    to: KITTENSWAP_CONTRACTS.router,
    value: swapValue,
    data: swapData,
  });

  const [poolAddress, gasPriceHex, gasEstimates, nativeBalanceCheck] = await Promise.all([
    withRpcRetry(() => readPoolAddressByPair(tokenIn, tokenOut, { factory: KITTENSWAP_CONTRACTS.factory })).catch(() => null),
    withRpcRetry(() => rpcGasPrice()).catch(() => null),
    Promise.all(calls.map((c) => estimateCallGas({ from: owner, to: c.to, data: c.data, value: c.value }))),
    useNativeIn
      ? rpcGetNativeBalance(owner).then((b) => ({ ok: true, balance: b })).catch((e) => ({ ok: false, balance: null, error: e?.message || String(e) }))
      : Promise.resolve(null),
  ]);
  const directSwapCall = await withRpcRetry(() => rpcCall(
    "eth_call",
    [{ from: owner, to: KITTENSWAP_CONTRACTS.router, data: swapData, value: toHexQuantity(swapValue) }, "latest"]
  ))
    .then((ret) => ({ ok: true, returnData: ret, error: null, revertHint: null }))
    .catch((err) => {
      const classified = classifyCallFailure(err);
      return {
        ok: false,
        category: classified.category,
        returnData: null,
        error: err?.message || String(err),
        revertHint: classified.revertHint,
      };
    });
  const hardBlockers = [];

  const gasPriceWei = gasPriceHex ? BigInt(gasPriceHex) : null;
  const totalGas = gasEstimates.reduce((acc, g) => (g.ok ? acc + g.gas : acc), 0n);
  const estFeeWei = gasPriceWei != null ? totalGas * gasPriceWei : null;

  const lines = [];
  lines.push("Kittenswap swap plan (exactInputSingle)");
  lines.push(`- from (tx sender): ${owner}`);
  lines.push(`- recipient: ${recipient}`);
  lines.push(`- router: ${KITTENSWAP_CONTRACTS.router}`);
  lines.push(`- deployer: ${deployer}`);
  lines.push(`- pool: ${poolAddress || "not found for token pair"}`);
  if (!poolAddress) {
    hardBlockers.push("pool for tokenIn/tokenOut is unavailable from factory read");
  }
  lines.push(`- token in: ${tokenInMeta.symbol} (${tokenInMeta.address})`);
  lines.push(`- token out: ${tokenOutMeta.symbol} (${tokenOutMeta.address})`);
  lines.push(`- amount in: ${formatUnits(amountIn, tokenInMeta.decimals, { precision: 8 })} ${tokenInMeta.symbol}`);
  lines.push(`- quoted amount out: ${formatUnits(quote.amountOut, tokenOutMeta.decimals, { precision: 8 })} ${tokenOutMeta.symbol}`);
  lines.push(`- minimum amount out: ${formatUnits(amountOutMin, tokenOutMeta.decimals, { precision: 8 })} ${tokenOutMeta.symbol}`);
  lines.push(`- quote fee tier: ${quote.fee}`);
  lines.push(`- quote ticks crossed: ${quote.initializedTicksCrossed}`);
  lines.push("- routing: single-hop exactInputSingle (multi-hop not enabled in this skill yet)");
  lines.push(`- policy: ${policyLoaded.key} (slippage=${effSlipBps}bps, deadline=${effDeadlineSec}s)`);
  lines.push(`- plan snapshot block: ${planBlockNumber == null ? "n/a" : planBlockNumber}`);
  lines.push(`- deadline unix: ${deadline.toString()}`);
  lines.push(`- deadline utc: ${deadlineIso}`);
  lines.push(`- deadline headroom now: ${deadlineHeadroomSec}s`);
  lines.push(`- wallet balances: ${tokenInMeta.balance == null ? "n/a" : `${formatUnits(tokenInMeta.balance, tokenInMeta.decimals, { precision: 8 })} ${tokenInMeta.symbol}`} | ${tokenOutMeta.balance == null ? "n/a" : `${formatUnits(tokenOutMeta.balance, tokenOutMeta.decimals, { precision: 8 })} ${tokenOutMeta.symbol}`}`);
  if (useNativeIn) {
    lines.push(`- native input mode: enabled (msg.value = ${formatUnits(swapValue, 18, { precision: 8 })} HYPE)`);
    lines.push(`- native HYPE balance: ${nativeBalanceCheck?.balance == null ? "n/a" : `${formatUnits(nativeBalanceCheck.balance, 18, { precision: 8 })} HYPE`}`);
    lines.push(`- preflight native balance check: ${nativeBalanceCheck?.balance == null ? "n/a" : nativeBalanceCheck.balance >= amountIn ? "PASS" : "FAIL"}`);
    if (nativeBalanceCheck?.balance != null && nativeBalanceCheck.balance < amountIn) {
      lines.push(`- BLOCKER: native HYPE balance is below amountIn for sender ${owner}`);
      hardBlockers.push("native balance is below amountIn");
    }
  } else {
    lines.push(`- router allowance (${tokenInMeta.symbol}): ${allowance == null ? "n/a" : formatUnits(allowance, tokenInMeta.decimals, { precision: 8 })}`);
    lines.push(`- preflight tokenIn balance check: ${tokenInMeta.balance == null ? "n/a" : tokenInMeta.balance >= amountIn ? "PASS" : "FAIL"}`);
    lines.push(`- preflight allowance check: ${allowance == null ? "n/a" : allowance >= amountIn ? "PASS" : "FAIL"}`);
    if (!allowanceCheck?.ok) {
      lines.push(`- allowance read: unavailable (${allowanceCheck.error})`);
    }
    lines.push(`- approval required: ${needsApproval ? "YES" : "NO"}`);
    if (insufficientTokenInBalance) {
      lines.push(`- BLOCKER: tokenIn balance is below amountIn for sender ${owner}`);
      hardBlockers.push("tokenIn balance is below amountIn");
    }
    if (insufficientAllowance) {
      lines.push(`- BLOCKER: allowance is below amountIn for sender ${owner}`);
      hardBlockers.push("router allowance is below amountIn");
    }
  }
  const swapSimLabel = directSwapCall.ok
    ? "PASS"
    : directSwapCall.category === "rpc_unavailable"
      ? "UNAVAILABLE (RPC timeout/rate-limit)"
      : `REVERT${directSwapCall.revertHint ? ` (${directSwapCall.revertHint})` : ""}`;
  lines.push(`- direct swap eth_call simulation: ${swapSimLabel}`);
  if (!directSwapCall.ok && directSwapCall.error) {
    lines.push(`- direct swap simulation error: ${directSwapCall.error}`);
  }
  if (!directSwapCall.ok) {
    if (directSwapCall.category === "rpc_unavailable") {
      lines.push("- BLOCKER: preflight simulation is unavailable due RPC instability; re-run until simulation is PASS before signing.");
      hardBlockers.push("direct swap simulation unavailable (RPC unstable)");
    } else {
      lines.push("- BLOCKER: direct swap simulation reverted; do not sign/send this swap until the blocker is resolved.");
      hardBlockers.push(`direct swap simulation reverted${directSwapCall.revertHint ? ` (${directSwapCall.revertHint})` : ""}`);
    }
  }
  const executionGateBlocked = hardBlockers.length > 0;
  lines.push(`- execution gate: ${executionGateBlocked ? "BLOCKED" : "PASS (eligible for signing after checklist)"}`);
  if (executionGateBlocked) {
    lines.push("- blocking reasons:");
    for (const reason of hardBlockers) {
      lines.push(`  - ${reason}`);
    }
    lines.push("- required remediation before signing:");
    if (insufficientTokenInBalance || (useNativeIn && nativeBalanceCheck?.balance != null && nativeBalanceCheck.balance < amountIn)) {
      lines.push(`  - reduce amount-in or top up ${tokenInMeta.symbol} balance, then regenerate swap-plan`);
    }
    if (insufficientAllowance) {
      lines.push(`  - run: krlp swap-approve-plan ${tokenInMeta.address} ${owner} --amount ${formatUnits(amountIn, tokenInMeta.decimals, { precision: 8 })}`);
      lines.push("  - send approve tx, wait success + 1 confirmation, then re-run swap-plan");
    }
    if (!directSwapCall.ok && directSwapCall.category !== "rpc_unavailable") {
      lines.push("  - adjust amount/slippage, regenerate swap-plan, require direct simulation PASS");
    }
    if (!directSwapCall.ok && directSwapCall.category === "rpc_unavailable") {
      lines.push("  - wait for RPC recovery and re-run swap-plan until simulation is PASS");
    }
    lines.push("- hard stop: do not sign or broadcast swap tx while execution gate is BLOCKED.");
  }

  lines.push("- transaction templates (full calldata):");
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i];
    const g = gasEstimates[i];
    lines.push(`  - step ${i + 1}: ${c.step}`);
    lines.push(`    - to: ${c.to}`);
    lines.push(`    - value: ${toHexQuantity(c.value)} (${formatUnits(c.value, 18, { precision: 8 })} HYPE)`);
    lines.push(`    - data: ${c.data}`);
    if (g.ok) lines.push(`    - gas est: ${g.gas.toString()} (${g.gasHex})`);
    else lines.push(`    - gas est: unavailable (${g.error})`);
  }

  if (gasPriceWei != null) {
    lines.push(`- gas price: ${formatUnits(gasPriceWei, 9, { precision: 3 })} gwei`);
    lines.push(`- total gas est (available steps): ${totalGas.toString()}`);
    lines.push(`- est total fee: ${formatUnits(estFeeWei, 18, { precision: 8 })} HYPE`);
  } else {
    lines.push("- gas price: unavailable");
  }

  lines.push("- execution:");
  if (executionGateBlocked) {
    lines.push("  - DO NOT sign/broadcast while execution gate is BLOCKED.");
  }
  lines.push("  - sign tx outside this skill (wallet/custody)");
  lines.push("  - broadcast signed payload: krlp broadcast-raw <0xSignedTx> --yes SEND");
  lines.push(`  - signer address MUST equal from=${owner}; mismatch commonly reverts with STF`);
  lines.push("  - stale calldata fails fast: if sent after deadline, contracts revert with 'Transaction too old' (often shown as silent revert)");
  lines.push("- block-safe execution order (mandatory):");
  if (needsApproval) {
    lines.push("  1. Sign and send only the approve step.");
    lines.push("  2. Wait for approve receipt status=success.");
    lines.push(`  3. Wait at least ${MIN_DEPENDENCY_CONFIRMATIONS} confirmation block after approve is mined.`);
    lines.push("  4. Verify approve result: krlp tx-verify <approveTxHash>");
    lines.push("  5. Re-run this swap-plan and require allowance PASS + direct simulation PASS.");
    lines.push("  6. Sign and send swap step only after 1-5 are all PASS.");
  } else {
    lines.push("  1. Re-run this swap-plan right before signing and require direct simulation PASS.");
    lines.push("  2. Sign and send swap step.");
  }
  lines.push("  - never submit dependent approve/swap txs in parallel.");
  if (planBlockNumber != null) {
    lines.push(`  - if chain advances by more than ${MAX_PLAN_STALENESS_BLOCKS} blocks since snapshot (${planBlockNumber}), regenerate swap-plan before signing.`);
  }
  if (gasEstimates.some((g) => !g.ok && /STF|safeTransferFrom|transferFrom/i.test(String(g.error || "")))) {
    lines.push("- simulation hint:");
    lines.push("  - swap gas simulation reverted with transfer/allowance failure (STF-like).");
    lines.push("  - if approve step is included, sign+send approve first, then re-simulate swap.");
  }
  lines.push("- safety:");
  lines.push("  - output uses full addresses and full calldata; do not truncate or reconstruct");
  lines.push("  - this command is dry-run only and does not sign/broadcast");
  lines.push("  - swap requires sufficient token balance and router allowance (unless --native-in)");
  lines.push("  - verify token/deployer pair against Kittenswap pool before signing");
  return lines.join("\n");
}

async function cmdMintPlan({
  tokenARef,
  tokenBRef,
  deployerRef,
  amountADecimal,
  amountBDecimal,
  ownerRef,
  recipientRef,
  policyRef,
  slippageBps,
  deadlineSeconds,
  tickLowerRef,
  tickUpperRef,
  widthTicksRef,
  centerTickRef,
  approveMax,
  allowOutOfRange,
  noAutoStake,
}) {
  const { tokenA, tokenB, token0, token1, inputAIsToken0 } = sortTokenPair(tokenARef, tokenBRef);
  const deployer = deployerRef ? assertAddress(deployerRef) : ZERO_ADDRESS;
  const owner = await resolveAddressInput(ownerRef || "", { allowDefault: true });
  const recipient = recipientRef ? await resolveAddressInput(recipientRef, { allowDefault: false }) : owner;

  const policyLoaded = await getPolicy(policyRef || "");
  const effSlipBps = parseBps(slippageBps, policyLoaded.policy.slippageBps, { min: 0, max: 10_000 });
  const effDeadlineSec = parseSeconds(deadlineSeconds, policyLoaded.policy.deadlineSeconds, { min: 1, max: 86_400 });

  const [tokenAMeta, tokenBMeta] = await Promise.all([
    withRpcRetry(() => readTokenSnapshot(tokenA, owner)),
    withRpcRetry(() => readTokenSnapshot(tokenB, owner)),
  ]);
  const token0Meta = inputAIsToken0 ? tokenAMeta : tokenBMeta;
  const token1Meta = inputAIsToken0 ? tokenBMeta : tokenAMeta;

  const amountA = parseDecimalToUnits(String(amountADecimal), tokenAMeta.decimals);
  const amountB = parseDecimalToUnits(String(amountBDecimal), tokenBMeta.decimals);
  if (amountA <= 0n || amountB <= 0n) throw new Error("amount-a and amount-b must be > 0");

  const amount0Desired = inputAIsToken0 ? amountA : amountB;
  const amount1Desired = inputAIsToken0 ? amountB : amountA;
  const amount0Min = (amount0Desired * BigInt(10_000 - effSlipBps)) / 10_000n;
  const amount1Min = (amount1Desired * BigInt(10_000 - effSlipBps)) / 10_000n;

  const poolAddress = await withRpcRetry(() => readPoolAddressByPair(token0, token1, { factory: KITTENSWAP_CONTRACTS.factory }));
  if (!poolAddress) {
    throw new Error(`No pool found for pair ${token0} / ${token1} on Kittenswap factory`);
  }
  const [poolState, tickSpacing] = await Promise.all([
    withRpcRetry(() => readPoolGlobalState(poolAddress)),
    withRpcRetry(() => readPoolTickSpacing(poolAddress)),
  ]);
  const spacing = Math.abs(Number(tickSpacing || 1));
  if (!Number.isFinite(spacing) || spacing < 1) {
    throw new Error(`Invalid pool tick spacing: ${tickSpacing}`);
  }

  const hasManualLower = tickLowerRef != null && String(tickLowerRef).trim() !== "";
  const hasManualUpper = tickUpperRef != null && String(tickUpperRef).trim() !== "";
  const hasManualCenter = centerTickRef != null && String(centerTickRef).trim() !== "";
  const allowOutOfRangeMint = parseBoolFlag(allowOutOfRange);
  let tickLower;
  let tickUpper;
  let rangeSource = "auto_centered";
  let rangeCenterRaw = null;
  let rangeCenterAligned = null;
  if (hasManualLower || hasManualUpper) {
    if (!hasManualLower || !hasManualUpper) {
      throw new Error("Provide both --tick-lower and --tick-upper, or neither.");
    }
    tickLower = parseInteger(tickLowerRef, { field: "tick-lower", min: MIN_ALGEBRA_TICK, max: MAX_ALGEBRA_TICK });
    tickUpper = parseInteger(tickUpperRef, { field: "tick-upper", min: MIN_ALGEBRA_TICK, max: MAX_ALGEBRA_TICK });
    rangeSource = "manual";
    rangeCenterRaw = tickLower + Math.floor((tickUpper - tickLower) / 2);
    rangeCenterAligned = alignTickNearest(rangeCenterRaw, spacing);
  } else {
    const widthRequested = parseOptionalInteger(widthTicksRef, 500, {
      field: "width-ticks",
      min: spacing * 2,
      max: MAX_ALGEBRA_TICK - MIN_ALGEBRA_TICK,
    });
    rangeCenterRaw = parseOptionalInteger(centerTickRef, poolState.tick, {
      field: "center-tick",
      min: MIN_ALGEBRA_TICK,
      max: MAX_ALGEBRA_TICK,
    });
    const widthAligned = Math.max(spacing * 2, Math.ceil(widthRequested / spacing) * spacing);
    rangeCenterAligned = alignTickNearest(rangeCenterRaw, spacing);
    tickLower = alignTickDown(rangeCenterAligned - Math.floor(widthAligned / 2), spacing);
    tickUpper = tickLower + widthAligned;
  }

  if (tickLower >= tickUpper) throw new Error(`Invalid tick range: [${tickLower}, ${tickUpper}]`);
  if (!isTickAligned(tickLower, spacing) || !isTickAligned(tickUpper, spacing)) {
    throw new Error(`Tick range must align to pool spacing ${spacing}. Got [${tickLower}, ${tickUpper}]`);
  }
  if (tickLower < MIN_ALGEBRA_TICK || tickUpper > MAX_ALGEBRA_TICK) {
    throw new Error(`Tick range must stay within [${MIN_ALGEBRA_TICK}, ${MAX_ALGEBRA_TICK}]`);
  }

  const latestBlock = await rpcGetBlockByNumber("latest", false).catch(() => null);
  const nowTs = latestBlock?.timestamp ? Number(BigInt(latestBlock.timestamp)) : Math.floor(Date.now() / 1000);
  const deadline = BigInt(nowTs + effDeadlineSec);
  const deadlineIso = new Date((nowTs + effDeadlineSec) * 1000).toISOString();
  const deadlineHeadroomSec = effDeadlineSec;

  const [allowance0Check, allowance1Check] = await Promise.all([
    withRpcRetry(() => readErc20Allowance(token0, owner, KITTENSWAP_CONTRACTS.positionManager))
      .then((value) => ({ ok: true, value, error: null }))
      .catch((e) => ({ ok: false, value: null, error: e?.message || String(e) })),
    withRpcRetry(() => readErc20Allowance(token1, owner, KITTENSWAP_CONTRACTS.positionManager))
      .then((value) => ({ ok: true, value, error: null }))
      .catch((e) => ({ ok: false, value: null, error: e?.message || String(e) })),
  ]);
  const allowance0 = allowance0Check.value;
  const allowance1 = allowance1Check.value;

  const insufficientBalance0 = token0Meta.balance != null && token0Meta.balance < amount0Desired;
  const insufficientBalance1 = token1Meta.balance != null && token1Meta.balance < amount1Desired;
  const insufficientAllowance0 = allowance0Check.ok && allowance0 < amount0Desired;
  const insufficientAllowance1 = allowance1Check.ok && allowance1 < amount1Desired;
  const needsApproval0 = !allowance0Check.ok || allowance0 < amount0Desired;
  const needsApproval1 = !allowance1Check.ok || allowance1 < amount1Desired;
  const approveAmount0 = parseBoolFlag(approveMax) ? maxUint256() : amount0Desired;
  const approveAmount1 = parseBoolFlag(approveMax) ? maxUint256() : amount1Desired;
  const autoStakeAfterMint = !parseBoolFlag(noAutoStake);
  const inRangeAtCurrentTick = poolState.tick >= tickLower && poolState.tick < tickUpper;
  const rangeSidePct = rangeSidePercents(poolState.tick, tickLower, tickUpper);
  const centerDistanceTicks = rangeCenterAligned == null ? null : Math.abs(poolState.tick - rangeCenterAligned);
  const centeredSuggestion = suggestCenteredRange({
    currentTick: poolState.tick,
    oldLower: tickLower,
    oldUpper: tickUpper,
    tickSpacing: spacing,
  });
  const zeroAnchoredWarning = likelyZeroAnchoredRange({
    currentTick: poolState.tick,
    tickLower,
    tickUpper,
    spacing,
  });

  const mintData = buildMintCalldata({
    token0,
    token1,
    deployer,
    tickLower,
    tickUpper,
    amount0Desired,
    amount1Desired,
    amount0Min,
    amount1Min,
    recipient,
    deadline,
  });

  const calls = [];
  if (needsApproval0) {
    calls.push({
      step: "approve_token0_for_position_manager",
      to: token0Meta.address,
      value: 0n,
      data: buildApproveCalldata({ spender: KITTENSWAP_CONTRACTS.positionManager, amount: approveAmount0 }),
    });
  }
  if (needsApproval1) {
    calls.push({
      step: "approve_token1_for_position_manager",
      to: token1Meta.address,
      value: 0n,
      data: buildApproveCalldata({ spender: KITTENSWAP_CONTRACTS.positionManager, amount: approveAmount1 }),
    });
  }
  calls.push({
    step: "mint_new_position",
    to: KITTENSWAP_CONTRACTS.positionManager,
    value: 0n,
    data: mintData,
  });

  const [gasPriceHex, gasEstimates] = await Promise.all([
    withRpcRetry(() => rpcGasPrice()).catch(() => null),
    Promise.all(calls.map((c) => estimateCallGas({ from: owner, to: c.to, data: c.data, value: c.value }))),
  ]);
  const directMintCall = await simulateMintCall({
    fromAddress: owner,
    mintData,
    blockTag: "latest",
  });

  const gasPriceWei = gasPriceHex ? BigInt(gasPriceHex) : null;
  const totalGas = gasEstimates.reduce((acc, g) => (g.ok ? acc + g.gas : acc), 0n);
  const estFeeWei = gasPriceWei != null ? totalGas * gasPriceWei : null;

  const poolPrice1Per0 = tickToPrice(poolState.tick, { decimals0: token0Meta.decimals, decimals1: token1Meta.decimals });
  const amount0DesiredNum = unitsToNumber(amount0Desired, token0Meta.decimals, { precision: 18 });
  const amount1DesiredNum = unitsToNumber(amount1Desired, token1Meta.decimals, { precision: 18 });
  const desiredRatio1Per0 = Number.isFinite(amount0DesiredNum) && amount0DesiredNum > 0 && Number.isFinite(amount1DesiredNum)
    ? amount1DesiredNum / amount0DesiredNum
    : null;
  const desiredVsPoolRatioPct = Number.isFinite(desiredRatio1Per0) && Number.isFinite(poolPrice1Per0) && poolPrice1Per0 > 0
    ? ((desiredRatio1Per0 - poolPrice1Per0) / poolPrice1Per0) * 100
    : null;
  const mintBalanceHint = buildBalanceRebalanceHint({
    token0: token0Meta,
    token1: token1Meta,
    price1Per0: poolPrice1Per0,
  }, owner);

  const lines = [];
  lines.push("Kittenswap LP mint plan (new position)");
  lines.push(`- from (tx sender): ${owner}`);
  lines.push(`- recipient: ${recipient}`);
  lines.push(`- position manager: ${KITTENSWAP_CONTRACTS.positionManager}`);
  lines.push(`- pool: ${poolAddress}`);
  lines.push(`- deployer: ${deployer}`);
  if (deployer === ZERO_ADDRESS) {
    lines.push("- deployer mode: default (zero-address deployer)");
  } else {
    lines.push("- deployer mode: custom deployer supplied");
    lines.push("- warning: verify custom deployer matches this pool before signing");
  }
  lines.push(`- tokenA input: ${tokenAMeta.symbol} (${tokenAMeta.address}) amount=${formatUnits(amountA, tokenAMeta.decimals, { precision: 8 })}`);
  lines.push(`- tokenB input: ${tokenBMeta.symbol} (${tokenBMeta.address}) amount=${formatUnits(amountB, tokenBMeta.decimals, { precision: 8 })}`);
  lines.push(`- mint token order: token0=${token0Meta.symbol} (${token0Meta.address}) token1=${token1Meta.symbol} (${token1Meta.address})`);
  if (!inputAIsToken0) {
    lines.push("- note: input token order was auto-normalized to token0/token1 for mint safety");
  }
  lines.push(`- current pool tick: ${poolState.tick}`);
  lines.push(`- pool tick spacing: ${spacing}`);
  lines.push(`- selected ticks: [${tickLower}, ${tickUpper}] (width=${tickUpper - tickLower}, source=${rangeSource})`);
  lines.push(`- selected range center tick (aligned): ${rangeCenterAligned == null ? "n/a" : rangeCenterAligned}`);
  if (rangeSource === "auto_centered") {
    lines.push(`- center tick input: ${rangeCenterRaw == null ? "n/a" : rangeCenterRaw} (${hasManualCenter ? "from --center-tick" : "default=current pool tick"})`);
  }
  lines.push(`- in-range at current tick: ${inRangeAtCurrentTick ? "YES" : "NO"}`);
  lines.push(`- range side pct at current tick: from lower=${rangeSidePct.fromLowerPct == null ? "n/a" : fmtPct(rangeSidePct.fromLowerPct)} | to upper=${rangeSidePct.toUpperPct == null ? "n/a" : fmtPct(rangeSidePct.toUpperPct)}`);
  lines.push("- signed tick model: ticks are int24 and can be negative; negative ranges are valid and common.");
  if (centerDistanceTicks != null) {
    lines.push(`- tick distance current->selected center: ${centerDistanceTicks}`);
  }
  lines.push(`- pool price token1/token0: ${poolPrice1Per0 == null ? "n/a" : fmtNum(poolPrice1Per0, { dp: 8 })}`);
  lines.push(`- desired ratio token1/token0: ${desiredRatio1Per0 == null ? "n/a" : fmtNum(desiredRatio1Per0, { dp: 8 })}`);
  if (desiredVsPoolRatioPct != null) {
    lines.push(`- desired vs pool ratio delta: ${fmtPct(desiredVsPoolRatioPct)}`);
  }
  const mintNearestEdgeTicks = nearestRangeEdgeTicks(poolState.tick, tickLower, tickUpper);
  if (mintNearestEdgeTicks != null) {
    lines.push(`- nearest range edge distance: ${mintNearestEdgeTicks} ticks`);
    if (poolState.tick >= tickLower && poolState.tick < tickUpper && mintNearestEdgeTicks <= spacing) {
      lines.push(`- warning: price is within ${spacing} tick(s) of range edge; mint can revert if tick moves before execution.`);
      lines.push("- mitigation: widen range (--width-ticks) or re-run mint-plan immediately before signing.");
    }
  }
  lines.push(`- desired amounts: ${formatUnits(amount0Desired, token0Meta.decimals, { precision: 8 })} ${token0Meta.symbol} + ${formatUnits(amount1Desired, token1Meta.decimals, { precision: 8 })} ${token1Meta.symbol}`);
  lines.push(`- minimum amounts (slippage guard): ${formatUnits(amount0Min, token0Meta.decimals, { precision: 8 })} ${token0Meta.symbol} + ${formatUnits(amount1Min, token1Meta.decimals, { precision: 8 })} ${token1Meta.symbol}`);
  lines.push(`- policy: ${policyLoaded.key} (slippage=${effSlipBps}bps, deadline=${effDeadlineSec}s)`);
  lines.push(`- deadline unix: ${deadline.toString()}`);
  lines.push(`- deadline utc: ${deadlineIso}`);
  lines.push(`- deadline headroom now: ${deadlineHeadroomSec}s`);
  lines.push(`- wallet balances: ${token0Meta.balance == null ? "n/a" : `${formatUnits(token0Meta.balance, token0Meta.decimals, { precision: 8 })} ${token0Meta.symbol}`} | ${token1Meta.balance == null ? "n/a" : `${formatUnits(token1Meta.balance, token1Meta.decimals, { precision: 8 })} ${token1Meta.symbol}`}`);
  if (mintBalanceHint) lines.push(`- wallet balance hint: ${mintBalanceHint.explanation}`);
  lines.push(`- manager allowance (${token0Meta.symbol}): ${allowance0 == null ? "n/a" : formatUnits(allowance0, token0Meta.decimals, { precision: 8 })}`);
  lines.push(`- manager allowance (${token1Meta.symbol}): ${allowance1 == null ? "n/a" : formatUnits(allowance1, token1Meta.decimals, { precision: 8 })}`);
  lines.push(`- preflight ${token0Meta.symbol} balance check: ${token0Meta.balance == null ? "n/a" : token0Meta.balance >= amount0Desired ? "PASS" : "FAIL"}`);
  lines.push(`- preflight ${token1Meta.symbol} balance check: ${token1Meta.balance == null ? "n/a" : token1Meta.balance >= amount1Desired ? "PASS" : "FAIL"}`);
  lines.push(`- preflight manager allowance (${token0Meta.symbol}) check: ${allowance0 == null ? "n/a" : allowance0 >= amount0Desired ? "PASS" : "FAIL"}`);
  lines.push(`- preflight manager allowance (${token1Meta.symbol}) check: ${allowance1 == null ? "n/a" : allowance1 >= amount1Desired ? "PASS" : "FAIL"}`);
  lines.push(`- approval required (${token0Meta.symbol}): ${needsApproval0 ? "YES" : "NO"}`);
  lines.push(`- approval required (${token1Meta.symbol}): ${needsApproval1 ? "YES" : "NO"}`);
  if (!allowance0Check.ok) lines.push(`- allowance read (${token0Meta.symbol}): unavailable (${allowance0Check.error})`);
  if (!allowance1Check.ok) lines.push(`- allowance read (${token1Meta.symbol}): unavailable (${allowance1Check.error})`);
  if (insufficientBalance0) lines.push(`- BLOCKER: wallet ${owner} has insufficient ${token0Meta.symbol} for amount0Desired`);
  if (insufficientBalance1) lines.push(`- BLOCKER: wallet ${owner} has insufficient ${token1Meta.symbol} for amount1Desired`);
  if (insufficientAllowance0) lines.push(`- BLOCKER: ${token0Meta.symbol} allowance to position manager is below amount0Desired`);
  if (insufficientAllowance1) lines.push(`- BLOCKER: ${token1Meta.symbol} allowance to position manager is below amount1Desired`);
  if (!inRangeAtCurrentTick && !allowOutOfRangeMint) {
    lines.push("- BLOCKER: selected tick range does not include current pool tick.");
    lines.push(`- suggested same-width range centered on live tick: [${centeredSuggestion.tickLower}, ${centeredSuggestion.tickUpper}]`);
    lines.push("- fix: for 'N tick range around market', use --width-ticks N and omit manual --tick-lower/--tick-upper.");
    lines.push(`- fix: or set --center-tick ${poolState.tick} (negative values are valid).`);
    lines.push("- override: if intentional out-of-range placement, pass --allow-out-of-range.");
  }
  if (zeroAnchoredWarning) {
    lines.push("- BLOCKER: selected range appears anchored near tick 0 while current market tick is far away.");
    lines.push("- likely cause: range width was interpreted as [-N/2,+N/2] instead of centering on current tick.");
  }
  const mintSimLabel = directMintCall.ok
    ? "PASS"
    : directMintCall.category === "rpc_unavailable"
      ? "UNAVAILABLE (RPC timeout/rate-limit)"
      : directMintCall.category === "unexpected_return_data"
        ? "UNSAFE (unexpected return data)"
      : `REVERT${directMintCall.revertHint ? ` (${directMintCall.revertHint})` : ""}`;
  lines.push(`- direct mint eth_call simulation: ${mintSimLabel}`);
  if (directMintCall.ok && directMintCall.mintPreview) {
    lines.push(`- mint simulation preview: liquidity=${directMintCall.mintPreview.liquidity.toString()}, spend≈${formatUnits(directMintCall.mintPreview.amount0, token0Meta.decimals, { precision: 8 })} ${token0Meta.symbol} + ${formatUnits(directMintCall.mintPreview.amount1, token1Meta.decimals, { precision: 8 })} ${token1Meta.symbol}`);
  }
  if (!directMintCall.ok && directMintCall.error) {
    lines.push(`- direct mint simulation error: ${directMintCall.error}`);
  }
  if (!directMintCall.ok) {
    if (directMintCall.category === "rpc_unavailable") {
      lines.push("- BLOCKER: mint preflight simulation is unavailable due RPC instability; re-run until simulation is PASS before signing.");
    } else {
      lines.push("- BLOCKER: direct mint simulation reverted; do not sign/send this mint until the blocker is resolved.");
      if (isPriceSlippageRevert(directMintCall.revertHint) || isPriceSlippageRevert(directMintCall.error)) {
        lines.push("- likely root cause: position-manager Price slippage check failed.");
        lines.push("- mitigation:");
        lines.push("  - re-run mint-plan immediately before signing (avoid stale price/range).");
        lines.push("  - align desired token ratio closer to current pool ratio (rebalance wallet first if needed).");
        lines.push("  - widen range and/or loosen mins with higher --slippage-bps (for thin pools, 200-500bps may be required).");
        lines.push("  - do not bypass simulation; require direct mint eth_call simulation = PASS before broadcast.");
      }
    }
  }

  lines.push("- transaction templates (full calldata):");
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i];
    const g = gasEstimates[i];
    lines.push(`  - step ${i + 1}: ${c.step}`);
    lines.push(`    - to: ${c.to}`);
    lines.push(`    - value: ${toHexQuantity(c.value)} (${formatUnits(c.value, 18, { precision: 8 })} HYPE)`);
    lines.push(`    - data: ${c.data}`);
    if (g.ok) lines.push(`    - gas est: ${g.gas.toString()} (${g.gasHex})`);
    else lines.push(`    - gas est: unavailable (${g.error})`);
  }

  if (gasPriceWei != null) {
    lines.push(`- gas price: ${formatUnits(gasPriceWei, 9, { precision: 3 })} gwei`);
    lines.push(`- total gas est (available steps): ${totalGas.toString()}`);
    lines.push(`- est total fee: ${formatUnits(estFeeWei, 18, { precision: 8 })} HYPE`);
  } else {
    lines.push("- gas price: unavailable");
  }

  lines.push("- execution:");
  lines.push("  - sign tx outside this skill (wallet/custody)");
  lines.push("  - then broadcast signed payload: krlp broadcast-raw <0xSignedTx> --yes SEND");
  lines.push(`  - signer address MUST equal from=${owner}; mismatch commonly reverts with STF`);
  lines.push("  - after each approve tx is mined, run: krlp tx-verify <approveTxHash> (amount/allowance must be non-zero)");
  lines.push("  - if mint tx fails, run: krlp tx-verify <mintTxHash> <expectedOwner|label> (includes signer/race forensics)");
  lines.push("  - stale calldata fails fast: if sent after deadline, contracts revert with 'Transaction too old' (often shown as silent revert)");
  if (autoStakeAfterMint) {
    lines.push("  - default post-mint policy: immediately continue to staking (no extra confirmation prompt)");
    lines.push("  - after mint tx is mined and tokenId is known, run in order:");
    lines.push("    1. krlp farm-status <newTokenId>");
    lines.push("    2. krlp farm-approve-plan <newTokenId>");
    lines.push("    3. krlp farm-enter-plan <newTokenId> --auto-key");
    lines.push("    4. krlp farm-collect-plan <newTokenId> --auto-key");
    lines.push("    5. krlp farm-claim-plan <rewardToken> --amount max");
  } else {
    lines.push("  - post-mint auto-stake policy: disabled by --no-auto-stake");
    lines.push("  - if you decide to stake later, use:");
    lines.push("    1. krlp farm-status <newTokenId>");
    lines.push("    2. krlp farm-approve-plan <newTokenId>");
    lines.push("    3. krlp farm-enter-plan <newTokenId> --auto-key");
  }
  if (!directMintCall.ok && (needsApproval0 || needsApproval1)) {
    lines.push("- simulation hint:");
    lines.push("  - mint simulation can revert until position-manager approvals are mined.");
    lines.push("  - sign and send approval tx(s) first, then re-run mint-plan.");
  }
  lines.push("- safety:");
  lines.push("  - output uses full addresses and full calldata; do not truncate or reconstruct");
  lines.push("  - this command is dry-run only and does not sign/broadcast");
  lines.push("  - LP mint approvals must target position manager (not swap router)");
  lines.push("  - ticks must be aligned to pool tick spacing to avoid reverts");
  return lines.join("\n");
}

async function cmdPlan({
  tokenIdRaw,
  ownerRef,
  recipientRef,
  policyRef,
  edgeBps,
  widthBumpTicks,
  slippageBps,
  deadlineSeconds,
  amount0Decimal,
  amount1Decimal,
  allowBurn,
  noAutoCompound,
}) {
  const tokenId = parseTokenId(tokenIdRaw);
  const owner = await resolveAddressInput(ownerRef || "", { allowDefault: true });
  const recipient = recipientRef ? await resolveAddressInput(recipientRef, { allowDefault: false }) : owner;

  const policyLoaded = await getPolicy(policyRef || "");
  const effEdgeBps = parseBps(edgeBps, policyLoaded.policy.edgeBps, { min: 0, max: 10_000 });
  const effSlipBps = parseBps(slippageBps, policyLoaded.policy.slippageBps, { min: 0, max: 10_000 });
  const effDeadlineSec = parseSeconds(deadlineSeconds, policyLoaded.policy.deadlineSeconds, { min: 1, max: 86_400 });

  const ctx = await loadPositionContext(tokenId, { ownerAddress: owner });
  const evald = evaluateRebalanceNeed({
    currentTick: ctx.poolState.tick,
    tickLower: ctx.position.tickLower,
    tickUpper: ctx.position.tickUpper,
    edgeBps: effEdgeBps,
  });
  const widthPolicy = computeCenteredRangeWithWidthBump({
    currentTick: ctx.poolState.tick,
    tickLower: ctx.position.tickLower,
    tickUpper: ctx.position.tickUpper,
    tickSpacing: ctx.tickSpacing,
    widthBumpTicks: parseNonNegativeIntegerOrDefault(widthBumpTicks, 0, "width-bump-ticks"),
  });
  const rec = widthPolicy.rec;

  const latestBlock = await rpcGetBlockByNumber("latest", false).catch(() => null);
  const nowTs = latestBlock?.timestamp ? Number(BigInt(latestBlock.timestamp)) : Math.floor(Date.now() / 1000);
  const deadline = BigInt(nowTs + effDeadlineSec);
  const deadlineIso = new Date((nowTs + effDeadlineSec) * 1000).toISOString();
  const deadlineHeadroomSec = effDeadlineSec;
  const uint128Max = maxUint128();
  const includeBurnStep = parseBoolFlag(allowBurn);
  const autoCompoundFlow = !parseBoolFlag(noAutoCompound);

  const collectBeforeData = buildCollectCalldata({
    tokenId,
    recipient,
    amount0Max: uint128Max,
    amount1Max: uint128Max,
  });

  const decreaseData = buildDecreaseLiquidityCalldata({
    tokenId,
    liquidity: ctx.position.liquidity,
    amount0Min: 0n,
    amount1Min: 0n,
    deadline,
  });

  const collectAfterData = buildCollectCalldata({
    tokenId,
    recipient,
    amount0Max: uint128Max,
    amount1Max: uint128Max,
  });

  const burnData = buildBurnCalldata({ tokenId });

  let amount0DesiredRaw = null;
  let amount1DesiredRaw = null;
  let mintData = null;
  let mintAmount0MinRaw = null;
  let mintAmount1MinRaw = null;
  let mintAllowance0Check = null;
  let mintAllowance1Check = null;
  let mintNeedsApproval0 = false;
  let mintNeedsApproval1 = false;
  let mintInsufficientAllowance0 = false;
  let mintInsufficientAllowance1 = false;
  let mintInsufficientBalance0 = false;
  let mintInsufficientBalance1 = false;

  if (amount0Decimal != null && amount1Decimal != null) {
    amount0DesiredRaw = parseDecimalToUnits(String(amount0Decimal), ctx.token0.decimals);
    amount1DesiredRaw = parseDecimalToUnits(String(amount1Decimal), ctx.token1.decimals);
    if (amount0DesiredRaw <= 0n || amount1DesiredRaw <= 0n) {
      throw new Error("amount0 and amount1 must be > 0 for mint calldata.");
    }
    mintAmount0MinRaw = (amount0DesiredRaw * BigInt(10_000 - effSlipBps)) / 10_000n;
    mintAmount1MinRaw = (amount1DesiredRaw * BigInt(10_000 - effSlipBps)) / 10_000n;
    mintData = buildMintCalldata({
      token0: ctx.position.token0,
      token1: ctx.position.token1,
      deployer: ctx.position.deployer,
      tickLower: rec.tickLower,
      tickUpper: rec.tickUpper,
      amount0Desired: amount0DesiredRaw,
      amount1Desired: amount1DesiredRaw,
      amount0Min: mintAmount0MinRaw,
      amount1Min: mintAmount1MinRaw,
      recipient,
      deadline,
    });

    [mintAllowance0Check, mintAllowance1Check] = await Promise.all([
      withRpcRetry(() => readErc20Allowance(ctx.position.token0, owner, KITTENSWAP_CONTRACTS.positionManager))
        .then((value) => ({ ok: true, value, error: null }))
        .catch((e) => ({ ok: false, value: null, error: e?.message || String(e) })),
      withRpcRetry(() => readErc20Allowance(ctx.position.token1, owner, KITTENSWAP_CONTRACTS.positionManager))
        .then((value) => ({ ok: true, value, error: null }))
        .catch((e) => ({ ok: false, value: null, error: e?.message || String(e) })),
    ]);
    mintNeedsApproval0 = !mintAllowance0Check.ok || mintAllowance0Check.value < amount0DesiredRaw;
    mintNeedsApproval1 = !mintAllowance1Check.ok || mintAllowance1Check.value < amount1DesiredRaw;
    mintInsufficientAllowance0 = mintAllowance0Check.ok && mintAllowance0Check.value < amount0DesiredRaw;
    mintInsufficientAllowance1 = mintAllowance1Check.ok && mintAllowance1Check.value < amount1DesiredRaw;
    mintInsufficientBalance0 = ctx.token0.balance != null && ctx.token0.balance < amount0DesiredRaw;
    mintInsufficientBalance1 = ctx.token1.balance != null && ctx.token1.balance < amount1DesiredRaw;
  }

  const calls = [
    { step: "collect_before", to: KITTENSWAP_CONTRACTS.positionManager, data: collectBeforeData, value: 0n },
    { step: "decrease_liquidity", to: KITTENSWAP_CONTRACTS.positionManager, data: decreaseData, value: 0n },
    { step: "collect_after", to: KITTENSWAP_CONTRACTS.positionManager, data: collectAfterData, value: 0n },
  ];
  if (includeBurnStep) {
    calls.push({ step: "burn_old_nft", to: KITTENSWAP_CONTRACTS.positionManager, data: burnData, value: 0n });
  }
  if (mintData && mintNeedsApproval0) {
    calls.push({
      step: "approve_token0_for_position_manager",
      to: ctx.position.token0,
      data: buildApproveCalldata({ spender: KITTENSWAP_CONTRACTS.positionManager, amount: amount0DesiredRaw }),
      value: 0n,
    });
  }
  if (mintData && mintNeedsApproval1) {
    calls.push({
      step: "approve_token1_for_position_manager",
      to: ctx.position.token1,
      data: buildApproveCalldata({ spender: KITTENSWAP_CONTRACTS.positionManager, amount: amount1DesiredRaw }),
      value: 0n,
    });
  }
  if (mintData) calls.push({ step: "mint_new_position", to: KITTENSWAP_CONTRACTS.positionManager, data: mintData, value: 0n });

  const [gasPriceHex, gasEstimates] = await Promise.all([
    withRpcRetry(() => rpcGasPrice()).catch(() => null),
    Promise.all(calls.map((c) => estimateCallGas({ from: owner, to: c.to, data: c.data, value: c.value }))),
  ]);
  const directMintCall = mintData
    ? await simulateMintCall({
      fromAddress: owner,
      mintData,
      blockTag: "latest",
    })
    : null;

  const [tokenFarmedIn, activeKey, depositIncentiveId] = await Promise.all([
    withRpcRetry(() => readTokenFarmedIn(tokenId, { positionManager: KITTENSWAP_CONTRACTS.positionManager })).catch(() => null),
    withRpcRetry(() => readEternalFarmingIncentiveKey(ctx.poolAddress, { eternalFarming: KITTENSWAP_CONTRACTS.eternalFarming })).catch(() => null),
    withRpcRetry(() => readFarmingCenterDeposit(tokenId, { farmingCenter: KITTENSWAP_CONTRACTS.farmingCenter })).catch(() => null),
  ]);
  const stakeState = classifyKittenswapFarmStakeState({
    tokenFarmedIn,
    farmingCenter: KITTENSWAP_CONTRACTS.farmingCenter,
    depositIncentiveId,
  });
  const isFarmed = stakeState.stakedInKittenswap;
  const rewardTokenAddress = activeKey?.rewardToken && activeKey.rewardToken !== ZERO_ADDRESS ? activeKey.rewardToken : null;
  const bonusRewardTokenAddress = activeKey?.bonusRewardToken && activeKey.bonusRewardToken !== ZERO_ADDRESS
    ? activeKey.bonusRewardToken
    : null;
  let bonusRewardRateRaw = null;
  if (isFarmed && depositIncentiveId && depositIncentiveId !== ZERO_BYTES32) {
    const incentiveState = await withRpcRetry(
      () => readEternalFarmingIncentive(depositIncentiveId, { eternalFarming: KITTENSWAP_CONTRACTS.eternalFarming })
    ).catch(() => null);
    if (incentiveState?.virtualPoolAddress && incentiveState.virtualPoolAddress !== ZERO_ADDRESS) {
      const virtualPoolState = await withRpcRetry(
        () => readEternalVirtualPoolRewardState(incentiveState.virtualPoolAddress)
      ).catch(() => null);
      bonusRewardRateRaw = virtualPoolState?.bonusRewardRate ?? null;
    }
  }
  const bonusRewardEmissionActive = isMeaningfulBigInt(bonusRewardRateRaw);
  const [rewardTokenMeta, bonusRewardTokenMeta] = await Promise.all([
    rewardTokenAddress ? readTokenSnapshot(rewardTokenAddress).catch(() => null) : Promise.resolve(null),
    bonusRewardTokenAddress ? readTokenSnapshot(bonusRewardTokenAddress).catch(() => null) : Promise.resolve(null),
  ]);

  const gasPriceWei = gasPriceHex ? BigInt(gasPriceHex) : null;
  const totalGas = gasEstimates.reduce((acc, g) => (g.ok ? acc + g.gas : acc), 0n);
  const estFeeWei = gasPriceWei != null ? totalGas * gasPriceWei : null;

  const balanceHint = buildBalanceRebalanceHint(ctx, owner);
  const nftOwnerMatch = ctx.nftOwner === owner;

  const lines = [];
  lines.push(`Kittenswap LP rebalance plan (${tokenId.toString()})`);
  lines.push(`- from (tx sender): ${owner}`);
  lines.push(`- recipient: ${recipient}`);
  lines.push(`- nft owner: ${ctx.nftOwner}${nftOwnerMatch ? "" : " [DIFFERS FROM from]"}`);
  lines.push(`- pool: ${ctx.poolAddress}`);
  lines.push(`- current ticks: [${ctx.position.tickLower}, ${ctx.position.tickUpper}] | current ${ctx.poolState.tick}`);
  lines.push(`- suggested ticks: [${rec.tickLower}, ${rec.tickUpper}]`);
  lines.push(`- width policy: base=${widthPolicy.baseWidth} ticks, bump=+${widthPolicy.bumpRequested} requested (+${widthPolicy.bumpApplied} applied), target=${widthPolicy.targetWidth} ticks`);
  const rebalanceNearestEdgeTicks = nearestRangeEdgeTicks(ctx.poolState.tick, rec.tickLower, rec.tickUpper);
  if (rebalanceNearestEdgeTicks != null) {
    lines.push(`- suggested range edge distance now: ${rebalanceNearestEdgeTicks} ticks`);
  }
  lines.push(`- decision: ${evald.shouldRebalance ? "REBALANCE" : "NO_REBALANCE"} (${evald.reason})`);
  lines.push(`- policy: ${policyLoaded.key} (edge=${effEdgeBps}bps, slippage=${effSlipBps}bps, deadline=${effDeadlineSec}s)`);
  lines.push(`- deadline unix: ${deadline.toString()}`);
  lines.push(`- deadline utc: ${deadlineIso}`);
  lines.push(`- deadline headroom now: ${deadlineHeadroomSec}s`);
  lines.push(`- burn old nft step included: ${includeBurnStep ? "YES (--allow-burn)" : "NO (default safety)"}`);
  lines.push(`- wallet balances: ${ctx.token0.balance == null ? "n/a" : formatUnits(ctx.token0.balance, ctx.token0.decimals, { precision: 8 })} ${ctx.token0.symbol} | ${ctx.token1.balance == null ? "n/a" : formatUnits(ctx.token1.balance, ctx.token1.decimals, { precision: 8 })} ${ctx.token1.symbol}`);
  lines.push(`- canonical farm status code: ${stakeState.statusCode}`);
  lines.push(`- farming status: ${isFarmed ? `STAKED_KITTENSWAP (${tokenFarmedIn})` : "NOT_STAKED_KITTENSWAP"}`);
  lines.push(`- tokenFarmedIn raw: ${tokenFarmedIn || ZERO_ADDRESS}`);
  lines.push(`- deposit incentiveId raw: ${depositIncentiveId || ZERO_BYTES32}`);
  if (rewardTokenAddress) {
    lines.push(`- active primary reward token: ${rewardTokenAddress}${rewardTokenMeta ? ` (${rewardTokenMeta.symbol})` : ""}`);
  }
  if (bonusRewardTokenAddress && bonusRewardEmissionActive) {
    lines.push(`- active secondary reward token (bonus): ${bonusRewardTokenAddress}${bonusRewardTokenMeta ? ` (${bonusRewardTokenMeta.symbol})` : ""}`);
  }
  if (!isFarmed && (stakeState.stakedElsewhere || stakeState.statusCode === "INCONSISTENT_FARM_STATE")) {
    lines.push("- BLOCKER: position is not in canonical STAKED_KITTENSWAP state; do not run farm-exit/collect until stake status is fixed.");
  }

  if (balanceHint) {
    lines.push(`- balance hint: ${balanceHint.explanation}`);
  }

  if (!mintData) {
    lines.push("- mint calldata: not generated (provide both --amount0 and --amount1 to include final mint step)");
  } else {
    lines.push(`- mint desired: ${formatUnits(amount0DesiredRaw, ctx.token0.decimals, { precision: 8 })} ${ctx.token0.symbol} + ${formatUnits(amount1DesiredRaw, ctx.token1.decimals, { precision: 8 })} ${ctx.token1.symbol}`);
    lines.push(`- mint minimums: ${formatUnits(mintAmount0MinRaw, ctx.token0.decimals, { precision: 8 })} ${ctx.token0.symbol} + ${formatUnits(mintAmount1MinRaw, ctx.token1.decimals, { precision: 8 })} ${ctx.token1.symbol}`);
    lines.push(`- manager allowance (${ctx.token0.symbol}): ${mintAllowance0Check?.value == null ? "n/a" : formatUnits(mintAllowance0Check.value, ctx.token0.decimals, { precision: 8 })}`);
    lines.push(`- manager allowance (${ctx.token1.symbol}): ${mintAllowance1Check?.value == null ? "n/a" : formatUnits(mintAllowance1Check.value, ctx.token1.decimals, { precision: 8 })}`);
    lines.push(`- preflight ${ctx.token0.symbol} balance check: ${ctx.token0.balance == null ? "n/a" : ctx.token0.balance >= amount0DesiredRaw ? "PASS" : "FAIL"}`);
    lines.push(`- preflight ${ctx.token1.symbol} balance check: ${ctx.token1.balance == null ? "n/a" : ctx.token1.balance >= amount1DesiredRaw ? "PASS" : "FAIL"}`);
    lines.push(`- preflight manager allowance (${ctx.token0.symbol}) check: ${mintAllowance0Check?.value == null ? "n/a" : mintAllowance0Check.value >= amount0DesiredRaw ? "PASS" : "FAIL"}`);
    lines.push(`- preflight manager allowance (${ctx.token1.symbol}) check: ${mintAllowance1Check?.value == null ? "n/a" : mintAllowance1Check.value >= amount1DesiredRaw ? "PASS" : "FAIL"}`);
    lines.push(`- approval required (${ctx.token0.symbol}): ${mintNeedsApproval0 ? "YES" : "NO"}`);
    lines.push(`- approval required (${ctx.token1.symbol}): ${mintNeedsApproval1 ? "YES" : "NO"}`);
    if (!mintAllowance0Check?.ok) lines.push(`- allowance read (${ctx.token0.symbol}): unavailable (${mintAllowance0Check.error})`);
    if (!mintAllowance1Check?.ok) lines.push(`- allowance read (${ctx.token1.symbol}): unavailable (${mintAllowance1Check.error})`);
    if (mintInsufficientBalance0) lines.push(`- BLOCKER: wallet ${owner} has insufficient ${ctx.token0.symbol} for mint amount0`);
    if (mintInsufficientBalance1) lines.push(`- BLOCKER: wallet ${owner} has insufficient ${ctx.token1.symbol} for mint amount1`);
    if (mintInsufficientAllowance0) lines.push(`- BLOCKER: ${ctx.token0.symbol} allowance to position manager is below mint amount0`);
    if (mintInsufficientAllowance1) lines.push(`- BLOCKER: ${ctx.token1.symbol} allowance to position manager is below mint amount1`);
    const rebalanceMintSimLabel = directMintCall?.ok
      ? "PASS"
      : directMintCall?.category === "rpc_unavailable"
        ? "UNAVAILABLE (RPC timeout/rate-limit)"
        : directMintCall?.category === "unexpected_return_data"
          ? "UNSAFE (unexpected return data)"
        : `REVERT${directMintCall?.revertHint ? ` (${directMintCall.revertHint})` : ""}`;
    lines.push(`- direct mint eth_call simulation: ${rebalanceMintSimLabel}`);
    if (directMintCall?.ok && directMintCall?.mintPreview) {
      lines.push(`- mint simulation preview: liquidity=${directMintCall.mintPreview.liquidity.toString()}, spend≈${formatUnits(directMintCall.mintPreview.amount0, ctx.token0.decimals, { precision: 8 })} ${ctx.token0.symbol} + ${formatUnits(directMintCall.mintPreview.amount1, ctx.token1.decimals, { precision: 8 })} ${ctx.token1.symbol}`);
    }
    if (!directMintCall?.ok && directMintCall?.error) {
      lines.push(`- direct mint simulation error: ${directMintCall.error}`);
    }
    if (!directMintCall?.ok) {
      if (directMintCall?.category === "rpc_unavailable") {
        lines.push("- BLOCKER: mint preflight simulation is unavailable due RPC instability; re-run until simulation is PASS before signing.");
      } else {
        lines.push("- BLOCKER: direct mint simulation reverted; do not sign/send this mint until the blocker is resolved.");
      }
    }
  }

  lines.push("- transaction templates (full calldata):");
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i];
    const g = gasEstimates[i];
    lines.push(`  - step ${i + 1}: ${c.step}`);
    lines.push(`    - to: ${c.to}`);
    lines.push(`    - value: ${toHexQuantity(c.value)} (${formatUnits(c.value, 18, { precision: 8 })} HYPE)`);
    lines.push(`    - data: ${c.data}`);
    if (g.ok) lines.push(`    - gas est: ${g.gas.toString()} (${g.gasHex})`);
    else lines.push(`    - gas est: unavailable (${g.error})`);
  }

  if (gasPriceWei != null) {
    lines.push(`- gas price: ${formatUnits(gasPriceWei, 9, { precision: 3 })} gwei`);
    lines.push(`- total gas est (available steps): ${totalGas.toString()}`);
    if (estFeeWei != null) lines.push(`- est total fee: ${formatUnits(estFeeWei, 18, { precision: 8 })} HYPE`);
  } else {
    lines.push("- gas price: unavailable");
  }

  lines.push("- default rebalance policy:");
  if (autoCompoundFlow) {
    lines.push("  - enabled: YES (disable only with --no-auto-compound)");
    lines.push("  - required sequence after this dry-run plan:");
    let stepNo = 1;
    if (isFarmed) {
      lines.push(`    ${stepNo}. Exit farming: krlp farm-exit-plan ${tokenId.toString()} ${owner} --auto-key`);
      stepNo += 1;
      if (rewardTokenAddress) {
        lines.push(`    ${stepNo}. Claim primary rewards: krlp farm-claim-plan ${rewardTokenAddress} ${owner} --amount max`);
      } else {
        lines.push(`    ${stepNo}. Claim primary rewards: krlp farm-claim-plan <rewardToken> <owner> --amount max`);
      }
      stepNo += 1;
      if (bonusRewardTokenAddress && bonusRewardTokenAddress !== rewardTokenAddress) {
        if (bonusRewardEmissionActive) {
          lines.push(`    ${stepNo}. Claim secondary rewards (bonus): krlp farm-claim-plan ${bonusRewardTokenAddress} ${owner} --amount max`);
        }
        if (bonusRewardEmissionActive) stepNo += 1;
      }
    } else {
      lines.push(`    ${stepNo}. Farming exit skipped (position is not currently staked).`);
      stepNo += 1;
    }
    lines.push(`    ${stepNo}. Collect fees + principal from old position using this plan (collect -> decrease -> collect).`);
    stepNo += 1;
    lines.push(`    ${stepNo}. Rebalance inventory to 50/50 notional between ${ctx.token0.symbol} and ${ctx.token1.symbol} at current pool price.`);
    if (bonusRewardTokenAddress && bonusRewardEmissionActive) {
      lines.push("       - include claimed KITTEN + bonus rewards in this 50/50 rebalance before mint.");
    } else {
      lines.push("       - include claimed KITTEN rewards in this 50/50 rebalance before mint.");
    }
    if (balanceHint) {
      lines.push(`       - current wallet skew hint: swap ~${fmtNum(balanceHint.amountIn, { dp: 6 })} ${balanceHint.tokenIn} -> ${balanceHint.tokenOut}.`);
    }
    stepNo += 1;
    lines.push(`    ${stepNo}. Mint the new position with balanced amounts (re-run plan with --amount0/--amount1 right before signing).`);
    stepNo += 1;
    lines.push(`    ${stepNo}. Immediately stake the new NFT without extra prompt:`);
    lines.push("       - krlp farm-status <newTokenId> <owner>");
    lines.push("       - krlp farm-approve-plan <newTokenId> <owner>");
    lines.push("       - krlp farm-enter-plan <newTokenId> <owner> --auto-key");
  } else {
    lines.push("  - enabled: NO (--no-auto-compound)");
    lines.push("  - manual mode: plan output will not assume default 50/50 compound-and-restake behavior.");
  }

  lines.push("- safety:");
  lines.push("  - output uses full addresses and full calldata; do not truncate or reconstruct");
  lines.push("  - dry-run only: this command does not sign or broadcast");
  lines.push("  - burn is excluded by default; include only with explicit --allow-burn");
  lines.push("  - if nft owner != from, execution will fail unless sender is approved operator");
  lines.push("  - LP mint approvals must target position manager (not swap router)");
  lines.push("  - stale calldata fails fast: if sent after deadline, contracts revert with 'Transaction too old' (often shown as silent revert)");
  lines.push("  - use strict amount mins instead of zero in production when possible");

  return lines.join("\n");
}

async function cmdBroadcastRaw({ signedTx, yesToken, wait = true }) {
  const raw = String(signedTx || "").trim();
  if (!raw) throw new Error("Usage: krlp broadcast-raw <0xSignedTx> --yes SEND [--no-wait]");
  if (String(yesToken) !== "SEND") {
    throw new Error('Broadcast blocked. Re-run with explicit confirmation: --yes SEND');
  }

  const txHash = await rpcSendRawTransaction(raw, { rpcUrl: DEFAULT_RPC_URL });
  const lines = [];
  lines.push("HyperEVM raw broadcast");
  lines.push(`- tx hash: ${txHash}`);
  lines.push(`- tx link: ${txLink(txHash)}`);

  if (wait) {
    const receipt = await waitForReceipt(txHash, { rpcUrl: DEFAULT_RPC_URL });
    const ok = receiptStatus(receipt);
    lines.push(`- receipt status: ${ok == null ? "n/a" : ok ? "success" : "revert"}`);
    if (receipt?.gasUsed) lines.push(`- gas used: ${Number.parseInt(receipt.gasUsed, 16)}`);
  } else {
    lines.push("- receipt wait: skipped (--no-wait)");
    lines.push("- warning: skipping receipt wait is unsafe for dependent tx chains (approve -> swap).");
  }

  return lines.join("\n");
}

async function cmdSwapVerify({ txHashRef, ownerRef = "" }) {
  const txHash = assertTxHash(txHashRef);
  const [tx, receipt] = await Promise.all([
    rpcCall("eth_getTransactionByHash", [txHash]),
    rpcCall("eth_getTransactionReceipt", [txHash]),
  ]);

  if (!tx) throw new Error(`Transaction not found: ${txHash}`);
  if (!receipt) {
    return [
      "Kittenswap swap verify",
      `- tx hash: ${txHash}`,
      `- tx link: ${txLink(txHash)}`,
      "- receipt: pending (not mined yet)",
    ].join("\n");
  }

  const txFrom = normalizeAddress(tx.from || "");
  const txTo = normalizeAddress(tx.to || "");
  const targetAddress = ownerRef
    ? await resolveAddressInput(ownerRef, { allowDefault: false })
    : (txFrom || assertAddress(tx.from));

  const decodedSwap = decodeSwapLikeInput(tx.input);
  const transferRows = summarizeTransfersForAddress(receipt, targetAddress);
  const tokenAddresses = new Set(transferRows.map((x) => x.address));
  if (decodedSwap?.tokenIn) tokenAddresses.add(decodedSwap.tokenIn);
  if (decodedSwap?.tokenOut) tokenAddresses.add(decodedSwap.tokenOut);
  const tokenMetaMap = await collectTokenMetaMap(tokenAddresses);

  const statusInt = receipt?.status == null ? null : Number.parseInt(receipt.status, 16);
  const statusLabel = statusInt == null ? "unknown" : statusInt === 1 ? "success" : "revert";
  const blockNumber = receipt?.blockNumber ? Number.parseInt(receipt.blockNumber, 16) : null;
  const txValueWei = hexToBigIntSafe(tx?.value, 0n);
  const gasUsed = receipt?.gasUsed ? hexToBigIntSafe(receipt.gasUsed, null) : null;
  const effectiveGasPrice = receipt?.effectiveGasPrice ? hexToBigIntSafe(receipt.effectiveGasPrice, null) : null;
  const txFeeWei = gasUsed != null && effectiveGasPrice != null ? gasUsed * effectiveGasPrice : null;
  const blockInfo = receipt?.blockNumber ? await rpcCall("eth_getBlockByNumber", [receipt.blockNumber, false]).catch(() => null) : null;
  const blockTs = blockInfo?.timestamp ? Number(BigInt(blockInfo.timestamp)) : null;
  const receiptLogCount = Array.isArray(receipt?.logs) ? receipt.logs.length : 0;
  const routerWNative = decodedSwap ? await readRouterWNativeToken().catch(() => null) : null;
  const isNativeInSwap = Boolean(decodedSwap && txValueWei > 0n && routerWNative && decodedSwap.tokenIn === routerWNative);
  const preTxBlockTag = blockNumber != null && blockNumber > 0 ? maybeBlockTagFromNumber(blockNumber - 1) : null;

  let swapForensics = null;
  if (decodedSwap && txFrom && !isNativeInSwap && preTxBlockTag) {
    const [allowanceBefore, allowanceNow, balanceBefore, balanceNow] = await Promise.all([
      readErc20Allowance(decodedSwap.tokenIn, txFrom, KITTENSWAP_CONTRACTS.router, { blockTag: preTxBlockTag }).catch(() => null),
      readErc20Allowance(decodedSwap.tokenIn, txFrom, KITTENSWAP_CONTRACTS.router).catch(() => null),
      readErc20Balance(decodedSwap.tokenIn, txFrom, { blockTag: preTxBlockTag }).catch(() => null),
      readErc20Balance(decodedSwap.tokenIn, txFrom).catch(() => null),
    ]);
    swapForensics = { allowanceBefore, allowanceNow, balanceBefore, balanceNow };
  }

  const sentCandidates = transferRows.filter((x) => x.sent > 0n).sort((a, b) => (b.sent > a.sent ? 1 : -1));
  const recvCandidates = transferRows.filter((x) => x.received > 0n).sort((a, b) => (b.received > a.received ? 1 : -1));
  const inferredTokenIn = sentCandidates.length ? sentCandidates[0].address : null;
  const inferredTokenOut = recvCandidates.length ? recvCandidates[0].address : null;
  const likelyAllowanceRace = Boolean(
    statusLabel !== "success" &&
    decodedSwap &&
    !isNativeInSwap &&
    receiptLogCount === 0 &&
    typeof decodedSwap.amountIn === "bigint" &&
    swapForensics?.allowanceBefore != null &&
    swapForensics.allowanceBefore < decodedSwap.amountIn &&
    swapForensics?.allowanceNow != null &&
    swapForensics.allowanceNow >= decodedSwap.amountIn
  );
  const likelyBalanceRace = Boolean(
    statusLabel !== "success" &&
    decodedSwap &&
    !isNativeInSwap &&
    receiptLogCount === 0 &&
    typeof decodedSwap.amountIn === "bigint" &&
    swapForensics?.balanceBefore != null &&
    swapForensics.balanceBefore < decodedSwap.amountIn &&
    swapForensics?.balanceNow != null &&
    swapForensics.balanceNow >= decodedSwap.amountIn
  );
  const explorerApprovalRaceHint = (
    statusLabel !== "success" &&
    decodedSwap &&
    decodedSwap.decodeShape === "partial_malformed" &&
    !isNativeInSwap &&
    txFrom &&
    blockNumber != null &&
    receiptLogCount === 0
  )
    ? await inferRouterApprovalAfterFailedSwap({ ownerAddress: txFrom, failedBlock: blockNumber }).catch(() => null)
    : null;
  const hasAllowanceShortfall = Boolean(
    statusLabel !== "success"
    && decodedSwap
    && !isNativeInSwap
    && typeof decodedSwap.amountIn === "bigint"
    && swapForensics?.allowanceBefore != null
    && swapForensics.allowanceBefore < decodedSwap.amountIn
  );
  const hasBalanceShortfall = Boolean(
    statusLabel !== "success"
    && decodedSwap
    && !isNativeInSwap
    && typeof decodedSwap.amountIn === "bigint"
    && swapForensics?.balanceBefore != null
    && swapForensics.balanceBefore < decodedSwap.amountIn
  );
  const likelyEarlyRouterAbort = Boolean(
    statusLabel !== "success"
    && txTo === KITTENSWAP_CONTRACTS.router
    && receiptLogCount === 0
    && typeof gasUsed === "bigint"
    && gasUsed <= 30_000n
  );
  const likelyMalformedSwapCalldata = Boolean(
    likelyEarlyRouterAbort
    && (!decodedSwap || decodedSwap.decodeShape === "partial_malformed")
  );
  const likelyMsgValueModeMismatch = Boolean(
    statusLabel !== "success"
    && decodedSwap
    && txValueWei > 0n
    && (!routerWNative || decodedSwap.tokenIn !== routerWNative)
  );

  const lines = [];
  lines.push("Kittenswap swap verify");
  lines.push(`- tx hash: ${txHash}`);
  lines.push(`- tx link: ${txLink(txHash)}`);
  lines.push(`- status: ${statusLabel}`);
  lines.push(`- block: ${blockNumber == null ? "n/a" : blockNumber}`);
  lines.push(`- from: ${tx.from || "n/a"}`);
  lines.push(`- to: ${tx.to || "contract creation"}`);
  lines.push(`- to == kittenswap router: ${txTo === KITTENSWAP_CONTRACTS.router ? "YES" : "NO"}`);
  lines.push(`- target wallet (delta view): ${targetAddress}`);

  if (gasUsed != null) lines.push(`- gas used: ${gasUsed.toString()}`);
  if (effectiveGasPrice != null) lines.push(`- effective gas price: ${formatUnits(effectiveGasPrice, 9, { precision: 6 })} gwei`);
  if (txFeeWei != null) lines.push(`- tx fee: ${formatUnits(txFeeWei, 18, { precision: 10 })} HYPE`);

  if (decodedSwap) {
    const tokenInMeta = tokenMetaMap.get(decodedSwap.tokenIn) || { symbol: "TOKEN", decimals: 18 };
    const tokenOutMeta = tokenMetaMap.get(decodedSwap.tokenOut) || { symbol: "TOKEN", decimals: 18 };
    lines.push("- decoded exactInputSingle calldata:");
    if (decodedSwap.wrapper === "multicall") {
      lines.push(`  - wrapper: multicall (${decodedSwap.multicall?.variant || "bytes[]"}, call #${(decodedSwap.callIndex ?? 0) + 1})`);
      if (typeof decodedSwap.multicall?.deadline === "bigint") {
        lines.push(`  - multicall deadline: ${decodedSwap.multicall.deadline.toString()}`);
      }
      if (Array.isArray(decodedSwap.multicall?.selectors)) {
        lines.push(`  - multicall selectors: ${decodedSwap.multicall.selectors.join(", ")}`);
      }
    }
    lines.push(`  - tokenIn: ${decodedSwap.tokenIn} (${tokenInMeta.symbol})`);
    lines.push(`  - tokenOut: ${decodedSwap.tokenOut} (${tokenOutMeta.symbol})`);
    lines.push(`  - deployer: ${decodedSwap.deployer}`);
    lines.push(`  - recipient: ${decodedSwap.recipient}`);
    lines.push(`  - decode shape: ${decodedSwap.decodeShape || "exactInputSingle_v8"}`);
    lines.push(`  - amountIn: ${typeof decodedSwap.amountIn === "bigint" ? `${formatUnits(decodedSwap.amountIn, tokenInMeta.decimals, { precision: 8 })} ${tokenInMeta.symbol}` : "n/a (malformed calldata)"}`);
    lines.push(`  - minAmountOut: ${typeof decodedSwap.amountOutMinimum === "bigint" ? `${formatUnits(decodedSwap.amountOutMinimum, tokenOutMeta.decimals, { precision: 8 })} ${tokenOutMeta.symbol}` : "n/a (malformed calldata)"}`);
    lines.push(`  - mode: ${isNativeInSwap ? "native-in (msg.value path, no ERC20 allowance required)" : "erc20-in (allowance required)"}`);
    lines.push(`  - tx value: ${formatUnits(txValueWei, 18, { precision: 8 })} HYPE`);
    lines.push(`  - deadline: ${typeof decodedSwap.deadline === "bigint" ? decodedSwap.deadline.toString() : "n/a (malformed calldata)"}`);
    if (blockTs != null && typeof decodedSwap.deadline === "bigint") {
      const deadlineCheck = analyzeDeadlineVsBlock(decodedSwap.deadline, blockTs);
      if (deadlineCheck) {
        lines.push(`  - deadline vs tx block: ${deadlineCheck.pass ? "PASS" : "FAIL"} (${deadlineCheck.rendered})`);
        if (deadlineCheck.unitHint) lines.push(`  - deadline unit hint: ${deadlineCheck.unitHint}`);
      }
    }
    if (swapForensics && typeof decodedSwap.amountIn === "bigint") {
      lines.push("- pre-execution state forensics (tokenIn -> router):");
      lines.push(`  - required amountIn: ${formatUnits(decodedSwap.amountIn, tokenInMeta.decimals, { precision: 8 })} ${tokenInMeta.symbol}`);
      lines.push(`  - allowance before tx block (N-1): ${formatUnits(swapForensics.allowanceBefore, tokenInMeta.decimals, { precision: 8 })} ${tokenInMeta.symbol}`);
      lines.push(`  - allowance now: ${formatUnits(swapForensics.allowanceNow, tokenInMeta.decimals, { precision: 8 })} ${tokenInMeta.symbol}`);
      lines.push(`  - balance before tx block (N-1): ${formatUnits(swapForensics.balanceBefore, tokenInMeta.decimals, { precision: 8 })} ${tokenInMeta.symbol}`);
      lines.push(`  - balance now: ${formatUnits(swapForensics.balanceNow, tokenInMeta.decimals, { precision: 8 })} ${tokenInMeta.symbol}`);
      if (statusLabel !== "success") {
        lines.push(`  - pre-tx allowance check: ${swapForensics.allowanceBefore >= decodedSwap.amountIn ? "PASS" : "FAIL"}`);
        lines.push(`  - pre-tx balance check: ${swapForensics.balanceBefore >= decodedSwap.amountIn ? "PASS" : "FAIL"}`);
      } else {
        lines.push("  - note: this tx succeeded; treat pre-tx snapshots as informational only.");
      }
    } else if (decodedSwap.decodeShape === "partial_malformed") {
      lines.push("- warning: calldata is malformed/truncated; amount/deadline-level diagnostics unavailable.");
    }
  } else {
    lines.push("- calldata decode: no exactInputSingle found (direct or nested multicall)");
  }

  lines.push("- ERC20 transfer deltas for target wallet:");
  if (!transferRows.length) {
    lines.push("  - none");
  } else {
    for (const row of transferRows) {
      const meta = tokenMetaMap.get(row.address) || { symbol: "TOKEN", decimals: 18 };
      lines.push(`  - ${meta.symbol} (${row.address})`);
      lines.push(`    - sent: ${formatUnits(row.sent, meta.decimals, { precision: 8 })}`);
      lines.push(`    - received: ${formatUnits(row.received, meta.decimals, { precision: 8 })}`);
      lines.push(`    - net: ${formatUnits(row.net, meta.decimals, { precision: 8 })}`);
      lines.push(`    - transfer events touching token: ${row.transferCount}`);
    }
  }

  if (inferredTokenIn || inferredTokenOut) {
    const inMeta = inferredTokenIn ? (tokenMetaMap.get(inferredTokenIn) || { symbol: "TOKEN" }) : null;
    const outMeta = inferredTokenOut ? (tokenMetaMap.get(inferredTokenOut) || { symbol: "TOKEN" }) : null;
    lines.push(`- inferred tokenIn (by sent delta): ${inferredTokenIn ? `${inferredTokenIn} (${inMeta.symbol})` : "n/a"}`);
    lines.push(`- inferred tokenOut (by received delta): ${inferredTokenOut ? `${inferredTokenOut} (${outMeta.symbol})` : "n/a"}`);
  }

  if (statusLabel !== "success") {
    lines.push("- warning: transaction did not succeed; deltas may be incomplete or zero");
    lines.push(`- receipt log count: ${receiptLogCount}`);
    if (decodedSwap && blockTs != null && typeof decodedSwap.deadline === "bigint" && decodedSwap.deadline <= BigInt(blockTs)) {
      lines.push("- likely cause: swap deadline was expired at execution ('Transaction too old').");
    }
    if (likelyAllowanceRace) {
      lines.push("- likely root cause: approval race (swap executed before approval was effective on-chain).");
      lines.push("- evidence: allowance before tx block was below amountIn, but allowance now is sufficient.");
      lines.push("- fix: wait for approve receipt success plus at least 1 confirmation block, then re-run swap-plan and submit swap.");
    } else if (explorerApprovalRaceHint) {
      lines.push("- likely root cause: approval race (malformed calldata prevented amount-level decode, but history confirms ordering issue).");
      lines.push(`- evidence: router approval mined after failed swap: ${explorerApprovalRaceHint.approvalTxHash} at block ${explorerApprovalRaceHint.approvalBlock}.`);
      lines.push("- fix: submit approve first, wait for receipt + confirmation block, re-run swap-plan, then submit swap.");
    } else if (likelyBalanceRace) {
      lines.push("- likely root cause: funding race (balance was insufficient at execution block, then increased later).");
      lines.push("- fix: wait for inbound funding confirmation, then re-run swap-plan and submit swap.");
    } else if (hasAllowanceShortfall && hasBalanceShortfall) {
      lines.push("- likely cause: both allowance and balance were below amountIn at execution block.");
      lines.push("- fix: top up/fund tokenIn balance, approve router for required amount, then re-run swap-plan before signing.");
    } else if (hasAllowanceShortfall) {
      lines.push("- likely cause: insufficient allowance at execution block.");
      lines.push("- fix: verify approval tx mined successfully with krlp tx-verify and only then submit swap.");
    } else if (hasBalanceShortfall) {
      lines.push("- likely cause: insufficient balance at execution block.");
      lines.push("- fix: fund wallet or reduce amount-in, then re-run swap-plan before signing.");
    }
    if (likelyMsgValueModeMismatch) {
      lines.push("- likely cause: msg.value was sent for a non-WHYPE tokenIn path.");
      lines.push("- fix: use --native-in only when tokenIn is WHYPE; otherwise set tx value to 0.");
    }
    if (likelyMalformedSwapCalldata) {
      lines.push("- likely cause: malformed/truncated router calldata (early abort pattern: low gas + zero logs).");
      lines.push("- fix: regenerate via krlp swap-plan and use exact to/value/data output without manual calldata edits.");
    } else if (
      likelyEarlyRouterAbort
      && !likelyAllowanceRace
      && !likelyBalanceRace
      && !hasAllowanceShortfall
      && !hasBalanceShortfall
      && !likelyMsgValueModeMismatch
    ) {
      lines.push("- pattern detected: early router abort (low gas + zero logs) with no decoded balance/allowance race.");
      lines.push("- fix: re-run swap-plan immediately before signing and require direct simulation PASS.");
    }
  }

  lines.push("- note: verify command is read-only and does not execute transactions");
  return lines.join("\n");
}

async function cmdTxVerify({ txHashRef, ownerRef = "" }) {
  const txHash = assertTxHash(txHashRef);
  const [tx, receipt] = await Promise.all([
    rpcCall("eth_getTransactionByHash", [txHash]),
    rpcCall("eth_getTransactionReceipt", [txHash]),
  ]);

  if (!tx) throw new Error(`Transaction not found: ${txHash}`);
  const selector = String(tx.input || "0x").slice(0, 10).toLowerCase();
  const txToForRouting = normalizeAddress(tx.to || "");
  const multicallDecoded = selector === "0xac9650d8" ? decodeMulticallInput(tx.input) : null;

  // For swap selector, reuse the richer swap verifier output.
  if (selector === "0x1679c792") {
    return cmdSwapVerify({ txHashRef: txHash, ownerRef });
  }
  if (
    selector === "0xac9650d8"
    && txToForRouting === KITTENSWAP_CONTRACTS.router
    && (decodeSwapLikeInput(tx.input) || multicallDecoded?.ok)
  ) {
    return cmdSwapVerify({ txHashRef: txHash, ownerRef });
  }

  const txFrom = normalizeAddress(tx.from || "");
  const txTo = normalizeAddress(tx.to || "");
  const ownerOverrideSupplied = String(ownerRef || "").trim().length > 0;
  const signerAddress = txFrom || assertAddress(tx.from);
  const owner = ownerRef
    ? await resolveAddressInput(ownerRef, { allowDefault: false })
    : signerAddress;

  const statusInt = receipt?.status == null ? null : Number.parseInt(receipt.status, 16);
  const statusLabel = statusInt == null ? "pending" : statusInt === 1 ? "success" : "revert";
  const blockNumber = receipt?.blockNumber ? Number.parseInt(receipt.blockNumber, 16) : null;
  const preTxBlockTag = blockNumber != null && blockNumber > 0 ? maybeBlockTagFromNumber(blockNumber - 1) : null;
  const txValueWei = hexToBigIntSafe(tx?.value, 0n);
  const gasUsed = receipt?.gasUsed ? hexToBigIntSafe(receipt.gasUsed, null) : null;
  const effectiveGasPrice = receipt?.effectiveGasPrice ? hexToBigIntSafe(receipt.effectiveGasPrice, null) : null;
  const txFeeWei = gasUsed != null && effectiveGasPrice != null ? gasUsed * effectiveGasPrice : null;
  const blockInfo = receipt?.blockNumber ? await rpcCall("eth_getBlockByNumber", [receipt.blockNumber, false]).catch(() => null) : null;
  const blockTs = blockInfo?.timestamp ? Number(BigInt(blockInfo.timestamp)) : null;

  const lines = [];
  lines.push("Kittenswap tx verify");
  lines.push(`- tx hash: ${txHash}`);
  lines.push(`- tx link: ${txLink(txHash)}`);
  lines.push(`- status: ${statusLabel}`);
  lines.push(`- block: ${blockNumber == null ? "n/a" : blockNumber}`);
  lines.push(`- from: ${tx.from || "n/a"}`);
  lines.push(`- to: ${tx.to || "contract creation"}`);
  lines.push(`- selector: ${selector || "n/a"}`);
  if (ownerOverrideSupplied) {
    lines.push(`- expected owner (input): ${owner}`);
    lines.push(`- tx sender matches expected owner: ${signerAddress === owner ? "PASS" : "FAIL"}`);
  }
  lines.push(`- tx value: ${formatUnits(txValueWei, 18, { precision: 8 })} HYPE`);
  if (gasUsed != null) lines.push(`- gas used: ${gasUsed.toString()}`);
  if (effectiveGasPrice != null) lines.push(`- effective gas price: ${formatUnits(effectiveGasPrice, 9, { precision: 6 })} gwei`);
  if (txFeeWei != null) lines.push(`- tx fee: ${formatUnits(txFeeWei, 18, { precision: 10 })} HYPE`);
  if (blockTs != null) lines.push(`- block timestamp: ${blockTs}`);

  const mintEnvelope = (selector === "0xfe3f3be7" || selector === "0xac9650d8")
    ? decodeMintLikeInput(tx.input)
    : null;

  if (selector === "0x095ea7b3") {
    const dec = decodeApproveInput(tx.input);
    if (!dec) {
      lines.push("- decode: failed (approve calldata malformed)");
      return lines.join("\n");
    }
    const token = txTo || assertAddress(tx.to);
    const currentBlock = await rpcBlockNumber().catch(() => null);
    const currentBlockNumber = currentBlock?.decimal ?? null;
    const confirmations = blockNumber != null && currentBlockNumber != null
      ? Math.max(0, currentBlockNumber - blockNumber + 1)
      : null;
    const dependencyReady = confirmations == null ? null : confirmations >= (MIN_DEPENDENCY_CONFIRMATIONS + 1);
    const tokenMeta = await readTokenSnapshot(token, owner).catch(() => null);
    const allowanceNow = await readErc20Allowance(token, owner, dec.spender).catch(() => null);

    lines.push("- decoded approve calldata:");
    lines.push(`  - token: ${token}${tokenMeta ? ` (${tokenMeta.symbol})` : ""}`);
    lines.push(`  - owner: ${owner}`);
    lines.push(`  - spender: ${dec.spender}`);
    lines.push(`  - amount raw: ${dec.amount.toString()}`);
    if (blockNumber != null) lines.push(`  - mined block: ${blockNumber}`);
    if (confirmations != null) lines.push(`  - confirmations now: ${confirmations}`);
    if (tokenMeta) {
      lines.push(`  - amount: ${formatUnits(dec.amount, tokenMeta.decimals, { precision: 8 })} ${tokenMeta.symbol}`);
      if (allowanceNow != null) {
        lines.push(`  - allowance now: ${formatUnits(allowanceNow, tokenMeta.decimals, { precision: 8 })} ${tokenMeta.symbol}`);
      }
    } else if (allowanceNow != null) {
      lines.push(`  - allowance now raw: ${allowanceNow.toString()}`);
    }
    if (dec.amount === 0n) {
      lines.push("- BLOCKER: this approval tx set allowance to zero.");
    }
    if (allowanceNow === 0n) {
      lines.push("- BLOCKER: current allowance is still zero; mint/swap requiring allowance will revert.");
    }
    if (statusLabel !== "success") {
      lines.push("- BLOCKER: approval tx is not successful; dependent swap/mint must not be sent.");
    } else {
      lines.push("- dependency gate:");
      lines.push(`  - require at least ${MIN_DEPENDENCY_CONFIRMATIONS} confirmation block after this approval before sending dependent swap/mint.`);
      if (dependencyReady != null) {
        lines.push(`  - dependency-ready now: ${dependencyReady ? "YES" : "NO"}`);
      }
      lines.push("  - then re-run swap-plan/mint-plan and require preflight PASS before signing.");
    }
    lines.push("- note: approve decode is read-only and does not execute transactions");
    return lines.join("\n");
  }

  if (selector === "0x832f630a") {
    const decFull = decodeApproveForFarmingInputDetailed(tx.input);
    if (!decFull) {
      lines.push("- decode: not approveForFarming input");
      return lines.join("\n");
    }
    if (!decFull.ok) {
      lines.push("- decode: failed (approveForFarming calldata malformed)");
      lines.push(`- malformed detail: ${decFull.error}`);
      lines.push(`- calldata bytes total: ${decFull.bytesTotal} (expected 100 bytes for selector + 3 words)`);
      if (typeof decFull.words === "number") lines.push(`- calldata words provided: ${decFull.words}`);
      if (decFull.partial?.tokenId != null) lines.push(`- partial tokenId decode: ${decFull.partial.tokenId.toString()}`);
      if (decFull.words === 0) {
        lines.push("- likely cause: selector-only payload was sent (arguments missing).");
      } else if (decFull.words === 2) {
        lines.push(`- likely cause: used 2-arg shape (tokenId,address). approveForFarming requires 3 args: (tokenId,bool,address).`);
        if (decFull.partial?.addressMaybeWord1) {
          lines.push(`- detected second word looked like address: ${decFull.partial.addressMaybeWord1}`);
        }
      }
      lines.push("- fix:");
      lines.push("  - do not hand-encode this calldata.");
      lines.push("  - generate canonical call with: krlp farm-approve-plan <tokenId> [owner|label]");
      lines.push("  - expected selector/signature: 0x832f630a = approveForFarming(uint256,bool,address)");
      return lines.join("\n");
    }
    const dec = decFull.decoded;
    const [managerCenter, currentApproval, tokenFarmedIn] = await Promise.all([
      readPositionManagerFarmingCenter({ positionManager: KITTENSWAP_CONTRACTS.positionManager }).catch(() => null),
      readPositionFarmingApproval(dec.tokenId, { positionManager: KITTENSWAP_CONTRACTS.positionManager }).catch(() => null),
      readTokenFarmedIn(dec.tokenId, { positionManager: KITTENSWAP_CONTRACTS.positionManager }).catch(() => null),
    ]);
    lines.push("- decoded approveForFarming calldata:");
    lines.push(`  - tokenId: ${dec.tokenId.toString()}`);
    lines.push(`  - approve: ${dec.approve ? "true" : "false"}`);
    lines.push(`  - farmingAddress: ${dec.farmingAddress}`);
    lines.push(`- manager farmingCenter(): ${managerCenter || "n/a"}`);
    lines.push(`- current farming approval: ${currentApproval || "n/a"}`);
    lines.push(`- current tokenFarmedIn: ${tokenFarmedIn || "n/a"}`);
    if (statusLabel !== "success") {
      lines.push("- BLOCKER: approveForFarming tx did not succeed.");
    } else if (dec.approve && currentApproval !== dec.farmingAddress) {
      lines.push("- BLOCKER: approval target mismatch after tx; re-check signer and tokenId.");
    } else if (dec.approve && managerCenter && managerCenter !== dec.farmingAddress) {
      lines.push("- BLOCKER: approved farming address differs from manager configured farming center.");
    } else {
      lines.push("- approval check: PASS");
    }
    lines.push("- note: tx verify is read-only and does not execute transactions");
    return lines.join("\n");
  }

  if (selector === "0x5739f0b9" || selector === "0x4473eca6" || selector === "0x6af00aee") {
    const dec = decodeFarmingActionInput(tx.input, selector);
    if (!dec) {
      lines.push("- decode: failed (farming calldata malformed)");
      return lines.join("\n");
    }
    const actionName = selector === "0x5739f0b9"
      ? "enterFarming"
      : selector === "0x4473eca6"
        ? "exitFarming"
        : "collectRewards";
    const farmingCenterAddress = txTo || KITTENSWAP_CONTRACTS.farmingCenter;
    const [nftOwner, farmingApproval, tokenApproval, tokenFarmedIn, depositIncentiveId, activeKey, rewardNow, bonusRewardNow, positionNow] = await Promise.all([
      readOwnerOf(dec.tokenId, { positionManager: KITTENSWAP_CONTRACTS.positionManager }).catch(() => null),
      readPositionFarmingApproval(dec.tokenId, { positionManager: KITTENSWAP_CONTRACTS.positionManager }).catch(() => null),
      readPositionManagerTokenApproval(dec.tokenId, { positionManager: KITTENSWAP_CONTRACTS.positionManager }).catch(() => null),
      readTokenFarmedIn(dec.tokenId, { positionManager: KITTENSWAP_CONTRACTS.positionManager }).catch(() => null),
      readFarmingCenterDeposit(dec.tokenId, { farmingCenter: farmingCenterAddress }).catch(() => null),
      readEternalFarmingIncentiveKey(dec.pool, { eternalFarming: KITTENSWAP_CONTRACTS.eternalFarming }).catch(() => null),
      readEternalFarmingRewardBalance(signerAddress, dec.rewardToken, { eternalFarming: KITTENSWAP_CONTRACTS.eternalFarming }).catch(() => null),
      readEternalFarmingRewardBalance(signerAddress, dec.bonusRewardToken, { eternalFarming: KITTENSWAP_CONTRACTS.eternalFarming }).catch(() => null),
      readPosition(dec.tokenId, { positionManager: KITTENSWAP_CONTRACTS.positionManager }).catch(() => null),
    ]);
    const tokenPoolByTokenId = positionNow
      ? await readPoolAddressByPair(positionNow.token0, positionNow.token1, { factory: KITTENSWAP_CONTRACTS.factory }).catch(() => null)
      : null;
    const expectedKeyByTokenPool = tokenPoolByTokenId
      ? await readEternalFarmingIncentiveKey(tokenPoolByTokenId, { eternalFarming: KITTENSWAP_CONTRACTS.eternalFarming }).catch(() => null)
      : null;
    const keyMatchesTokenPool = !tokenPoolByTokenId || dec.pool === tokenPoolByTokenId;
    const keyMatchesExpectedIncentive = !expectedKeyByTokenPool || (
      dec.pool === expectedKeyByTokenPool.pool
      && dec.rewardToken === expectedKeyByTokenPool.rewardToken
      && dec.bonusRewardToken === expectedKeyByTokenPool.bonusRewardToken
      && dec.nonce === expectedKeyByTokenPool.nonce
    );
    const operatorApproval = nftOwner
      ? await readPositionManagerIsApprovedForAll(nftOwner, farmingCenterAddress, { positionManager: KITTENSWAP_CONTRACTS.positionManager }).catch(() => null)
      : null;
    const tokenTransferApprovalOk = hasFarmingTokenTransferApproval({
      tokenApproval,
      operatorApproved: operatorApproval,
      farmingCenter: farmingCenterAddress,
    });
    const replayLatest = statusLabel !== "success"
      ? await replayEthCall({
        fromAddress: signerAddress,
        toAddress: farmingCenterAddress,
        data: tx.input,
        value: tx.value || "0x0",
        blockTag: "latest",
      })
      : null;
    const replayLabel = replayLatest == null
      ? "n/a"
      : replayLatest.ok
        ? "PASS"
        : replayLatest.category === "rpc_unavailable"
          ? "UNAVAILABLE (RPC timeout/rate-limit)"
          : replayLatest.category === "insufficient_native_balance_for_replay"
            ? "SKIPPED (insufficient native balance for replay)"
            : `REVERT${replayLatest.revertHint ? ` (${replayLatest.revertHint})` : ""}`;
    const [rewardMeta, bonusMeta] = await Promise.all([
      readTokenSnapshot(dec.rewardToken).catch(() => null),
      readTokenSnapshot(dec.bonusRewardToken).catch(() => null),
    ]);
    lines.push(`- decoded ${actionName} calldata:`);
    lines.push(`  - tokenId: ${dec.tokenId.toString()}`);
    lines.push(`  - rewardToken: ${dec.rewardToken}${rewardMeta ? ` (${rewardMeta.symbol})` : ""}`);
    lines.push(`  - bonusRewardToken: ${dec.bonusRewardToken}${bonusMeta ? ` (${bonusMeta.symbol})` : ""}`);
    lines.push(`  - pool: ${dec.pool}`);
    lines.push(`  - nonce: ${dec.nonce.toString()}`);
    lines.push(`- farming center tx target: ${farmingCenterAddress}`);
    lines.push(`- nft owner now: ${nftOwner || "n/a"}`);
    lines.push(`- signer matches nft owner: ${nftOwner ? (signerAddress === nftOwner ? "PASS" : "FAIL") : "n/a"}`);
    if (positionNow) {
      lines.push(`- decoded tokenId pair now: ${positionNow.token0} / ${positionNow.token1}`);
    }
    lines.push(`- pool resolved from tokenId pair: ${tokenPoolByTokenId || "n/a"}`);
    lines.push(`- calldata pool matches tokenId pool: ${keyMatchesTokenPool ? "PASS" : "FAIL"}`);
    if (expectedKeyByTokenPool && expectedKeyByTokenPool.pool !== ZERO_ADDRESS) {
      lines.push(`- expected key for tokenId pool: reward=${expectedKeyByTokenPool.rewardToken}, bonus=${expectedKeyByTokenPool.bonusRewardToken}, nonce=${expectedKeyByTokenPool.nonce.toString()}`);
      lines.push(`- calldata key matches expected pool incentive key: ${keyMatchesExpectedIncentive ? "PASS" : "FAIL"}`);
    }
    lines.push(`- farming approval now (position manager): ${farmingApproval || "n/a"}`);
    lines.push(`- token approval now (getApproved): ${tokenApproval || "n/a"}`);
    lines.push(`- operator approval now (isApprovedForAll owner->farmingCenter): ${operatorApproval == null ? "n/a" : operatorApproval ? "true" : "false"}`);
    lines.push(`- token transfer approval to farming center now: ${tokenTransferApprovalOk ? "PASS" : "FAIL"}`);
    lines.push(`- tokenFarmedIn now: ${tokenFarmedIn || "n/a"}`);
    lines.push(`- farmingCenter deposit incentiveId: ${depositIncentiveId || "n/a"}`);
    if (activeKey && activeKey.pool !== ZERO_ADDRESS) {
      lines.push(`- active key on eternal farming: reward=${activeKey.rewardToken}, bonus=${activeKey.bonusRewardToken}, nonce=${activeKey.nonce.toString()}`);
    } else {
      lines.push("- active key on eternal farming: n/a");
    }
    lines.push(`- signer reward balance now (${rewardMeta?.symbol || dec.rewardToken}): ${rewardNow == null ? "n/a" : formatUnits(rewardNow, rewardMeta?.decimals ?? 18, { precision: 8 })}`);
    lines.push(`- signer reward balance now (${bonusMeta?.symbol || dec.bonusRewardToken}): ${bonusRewardNow == null ? "n/a" : formatUnits(bonusRewardNow, bonusMeta?.decimals ?? 18, { precision: 8 })}`);
    if (replayLatest != null) {
      lines.push(`- replay eth_call latest: ${replayLabel}`);
      if (!replayLatest.ok && replayLatest.error) lines.push(`- replay eth_call error: ${replayLatest.error}`);
    }
    if (statusLabel !== "success") {
      lines.push(`- BLOCKER: ${actionName} tx did not succeed.`);
      if (selector === "0x5739f0b9" && (!keyMatchesTokenPool || !keyMatchesExpectedIncentive || (nftOwner && signerAddress !== nftOwner))) {
        lines.push("- likely root cause: wrong tokenId and/or malformed incentive key calldata for enterFarming.");
        lines.push("- fix:");
        lines.push("  - do not hand-encode enterFarming calldata.");
        lines.push("  - regenerate with: krlp farm-enter-plan <tokenId> <owner> --auto-key");
        lines.push("  - ensure tx sender equals nft owner and key matches pool incentive.");
      }
      const likelyTokenApprovalFailure = (
        includesInsensitive(replayLatest?.revertHint, "not approved for token")
        || includesInsensitive(replayLatest?.error, "not approved for token")
      );
      if (selector === "0x5739f0b9" && (!tokenTransferApprovalOk || likelyTokenApprovalFailure)) {
        lines.push("- likely root cause: farming center was not approved to transfer the NFT tokenId.");
        lines.push("- fix:");
        lines.push("  - submit ERC721 approval on position manager from nft owner:");
        lines.push("    setApprovalForAll(farmingCenter,true) OR approve(tokenId,farmingCenter)");
        lines.push("  - confirm with krlp farm-status <tokenId> that token transfer approval is PASS");
        lines.push("  - then submit approveForFarming(tokenId,true,farmingCenter), then enterFarming");
      }
    } else if (selector === "0x5739f0b9" && tokenFarmedIn !== farmingCenterAddress) {
      lines.push("- BLOCKER: tokenFarmedIn does not match farming center after enterFarming.");
    } else if (selector === "0x4473eca6" && tokenFarmedIn !== ZERO_ADDRESS) {
      lines.push("- BLOCKER: token still marked as farmed after exitFarming.");
    } else {
      lines.push(`- ${actionName} check: PASS`);
    }
    lines.push("- note: tx verify is read-only and does not execute transactions");
    return lines.join("\n");
  }

  if (selector === "0x2f2d783d") {
    const dec = decodeFarmingClaimInput(tx.input);
    if (!dec) {
      lines.push("- decode: failed (claimReward calldata malformed)");
      return lines.join("\n");
    }
    const [tokenMeta, rewardBalanceNow] = await Promise.all([
      readTokenSnapshot(dec.rewardToken).catch(() => null),
      readEternalFarmingRewardBalance(signerAddress, dec.rewardToken, { eternalFarming: KITTENSWAP_CONTRACTS.eternalFarming }).catch(() => null),
    ]);
    lines.push("- decoded claimReward calldata:");
    lines.push(`  - rewardToken: ${dec.rewardToken}${tokenMeta ? ` (${tokenMeta.symbol})` : ""}`);
    lines.push(`  - to: ${dec.to}`);
    lines.push(`  - amountRequested: ${dec.amountRequested.toString()}`);
    lines.push(`- signer reward balance now: ${rewardBalanceNow == null ? "n/a" : formatUnits(rewardBalanceNow, tokenMeta?.decimals ?? 18, { precision: 8 })}`);
    if (statusLabel !== "success") {
      lines.push("- BLOCKER: claimReward tx did not succeed.");
    }
    lines.push("- note: tx verify is read-only and does not execute transactions");
    return lines.join("\n");
  }

  if (selector === "0xfe3f3be7" && !mintEnvelope?.mint) {
    const inputLen = String(tx.input || "0x").length;
    const bytesTotal = inputLen >= 2 ? Math.floor((inputLen - 2) / 2) : 0;
    const expectedBytes = 4 + (11 * 32);
    lines.push("- decode: failed (mint calldata malformed)");
    lines.push(`- calldata bytes total: ${bytesTotal} (expected ${expectedBytes} for mint selector + 11 words)`);
    if (gasUsed != null && gasUsed <= 30_000n) {
      lines.push("- likely class: fast-fail validation revert from malformed/partial mint calldata.");
    }
    lines.push("- fix:");
    lines.push("  - do not hand-encode mint calldata.");
    lines.push("  - regenerate canonical mint calldata with: krlp mint-plan ...");
    lines.push("  - for rebalance path, use: krlp plan <tokenId> ... and sign only generated payloads.");
    lines.push("- note: tx verify is read-only and does not execute transactions");
    return lines.join("\n");
  }

  if (mintEnvelope?.mint) {
    const dec = mintEnvelope.mint;
    if (!dec) {
      lines.push("- decode: failed (mint calldata malformed)");
      return lines.join("\n");
    }
    const txToAddress = txTo || assertAddress(tx.to);
    const [token0Meta, token1Meta] = await Promise.all([
      readTokenSnapshot(dec.token0).catch(() => null),
      readTokenSnapshot(dec.token1).catch(() => null),
    ]);
    const poolAddress = await readPoolAddressByPair(dec.token0, dec.token1, { factory: KITTENSWAP_CONTRACTS.factory }).catch(() => null);
    const [poolState, tickSpacing] = poolAddress
      ? await Promise.all([
        readPoolGlobalState(poolAddress).catch(() => null),
        readPoolTickSpacing(poolAddress).catch(() => null),
      ])
      : [null, null];
    const inRangeAtBlock = poolState ? (poolState.tick >= dec.tickLower && poolState.tick < dec.tickUpper) : null;
    const selectedRangeCenterTick = centerTickOfRange(dec.tickLower, dec.tickUpper, tickSpacing ?? 1);
    const selectedRangeZeroAnchored = poolState
      ? likelyZeroAnchoredRange({
        currentTick: poolState.tick,
        tickLower: dec.tickLower,
        tickUpper: dec.tickUpper,
        spacing: tickSpacing ?? 1,
      })
      : false;
    const poolPrice1Per0 = poolState
      ? tickToPrice(poolState.tick, { decimals0: token0Meta?.decimals ?? 18, decimals1: token1Meta?.decimals ?? 18 })
      : null;
    const amount0DesiredNum = unitsToNumber(dec.amount0Desired, token0Meta?.decimals ?? 18, { precision: 18 });
    const amount1DesiredNum = unitsToNumber(dec.amount1Desired, token1Meta?.decimals ?? 18, { precision: 18 });
    const desiredRatio1Per0 = Number.isFinite(amount0DesiredNum) && amount0DesiredNum > 0 && Number.isFinite(amount1DesiredNum)
      ? amount1DesiredNum / amount0DesiredNum
      : null;
    const desiredVsPoolRatioPct = Number.isFinite(desiredRatio1Per0) && Number.isFinite(poolPrice1Per0) && poolPrice1Per0 > 0
      ? ((desiredRatio1Per0 - poolPrice1Per0) / poolPrice1Per0) * 100
      : null;
    const [allow0NowSigner, allow1NowSigner, bal0NowSigner, bal1NowSigner] = await Promise.all([
      readErc20Allowance(dec.token0, signerAddress, KITTENSWAP_CONTRACTS.positionManager).catch(() => null),
      readErc20Allowance(dec.token1, signerAddress, KITTENSWAP_CONTRACTS.positionManager).catch(() => null),
      readErc20Balance(dec.token0, signerAddress).catch(() => null),
      readErc20Balance(dec.token1, signerAddress).catch(() => null),
    ]);
    const [allow0BeforeSigner, allow1BeforeSigner, bal0BeforeSigner, bal1BeforeSigner] = preTxBlockTag
      ? await Promise.all([
        readErc20Allowance(dec.token0, signerAddress, KITTENSWAP_CONTRACTS.positionManager, { blockTag: preTxBlockTag }).catch(() => null),
        readErc20Allowance(dec.token1, signerAddress, KITTENSWAP_CONTRACTS.positionManager, { blockTag: preTxBlockTag }).catch(() => null),
        readErc20Balance(dec.token0, signerAddress, { blockTag: preTxBlockTag }).catch(() => null),
        readErc20Balance(dec.token1, signerAddress, { blockTag: preTxBlockTag }).catch(() => null),
      ])
      : [null, null, null, null];
    const [allow0NowExpected, allow1NowExpected] = ownerOverrideSupplied && owner !== signerAddress
      ? await Promise.all([
        readErc20Allowance(dec.token0, owner, KITTENSWAP_CONTRACTS.positionManager).catch(() => null),
        readErc20Allowance(dec.token1, owner, KITTENSWAP_CONTRACTS.positionManager).catch(() => null),
      ])
      : [null, null];

    const [replayAtPre, replayAtLatest] = await Promise.all([
      preTxBlockTag
        ? replayEthCall({
          fromAddress: signerAddress,
          toAddress: txToAddress,
          data: tx.input,
          value: tx.value || "0x0",
          blockTag: preTxBlockTag,
        })
        : Promise.resolve(null),
      replayEthCall({
        fromAddress: signerAddress,
        toAddress: txToAddress,
        data: tx.input,
        value: tx.value || "0x0",
        blockTag: "latest",
      }),
    ]);
    const replayLatestMintDecoded = replayAtLatest?.ok ? decodeMintReturnData(replayAtLatest.returnData) : null;
    const replayLabel = (r) => {
      if (!r) return "n/a";
      if (r.ok) return "PASS";
      if (r.category === "insufficient_native_balance_for_replay") return "SKIPPED (insufficient native balance for replay)";
      if (r.category === "rpc_unavailable") return "UNAVAILABLE (RPC timeout/rate-limit)";
      return `REVERT${r.revertHint ? ` (${r.revertHint})` : ""}`;
    };

    lines.push("- decoded mint calldata:");
    if (mintEnvelope.wrapper === "multicall") {
      lines.push(`  - wrapper: multicall (${mintEnvelope.multicall?.variant || "bytes[]"}, call #${(mintEnvelope.callIndex ?? 0) + 1})`);
      if (typeof mintEnvelope.multicall?.deadline === "bigint") {
        lines.push(`  - multicall deadline: ${mintEnvelope.multicall.deadline.toString()}`);
      }
      if (Array.isArray(mintEnvelope.multicall?.selectors)) {
        lines.push(`  - multicall selectors: ${mintEnvelope.multicall.selectors.join(", ")}`);
      }
    }
    lines.push(`  - token0: ${dec.token0}${token0Meta ? ` (${token0Meta.symbol})` : ""}`);
    lines.push(`  - token1: ${dec.token1}${token1Meta ? ` (${token1Meta.symbol})` : ""}`);
    lines.push(`  - deployer: ${dec.deployer}`);
    lines.push(`  - recipient: ${dec.recipient}`);
    lines.push(`  - ticks: [${dec.tickLower}, ${dec.tickUpper}]`);
    lines.push(`  - selected range center tick: ${selectedRangeCenterTick == null ? "n/a" : selectedRangeCenterTick}`);
    lines.push(`  - amount0Desired: ${token0Meta ? `${formatUnits(dec.amount0Desired, token0Meta.decimals, { precision: 8 })} ${token0Meta.symbol}` : dec.amount0Desired.toString()}`);
    lines.push(`  - amount1Desired: ${token1Meta ? `${formatUnits(dec.amount1Desired, token1Meta.decimals, { precision: 8 })} ${token1Meta.symbol}` : dec.amount1Desired.toString()}`);
    lines.push(`  - amount0Min: ${token0Meta ? `${formatUnits(dec.amount0Min, token0Meta.decimals, { precision: 8 })} ${token0Meta.symbol}` : dec.amount0Min.toString()}`);
    lines.push(`  - amount1Min: ${token1Meta ? `${formatUnits(dec.amount1Min, token1Meta.decimals, { precision: 8 })} ${token1Meta.symbol}` : dec.amount1Min.toString()}`);
    lines.push(`  - deadline: ${dec.deadline.toString()}`);
    if (txValueWei > 0n) {
      lines.push(`  - native value attached: ${formatUnits(txValueWei, 18, { precision: 8 })} HYPE (multicall/native mint path)`);
    }
    lines.push(`- token order check (token0 < token1): ${dec.token0 < dec.token1 ? "PASS" : "FAIL"}`);
    lines.push(`- factory poolByPair(token0, token1): ${poolAddress || "not found"}`);
    if (poolState) lines.push(`- current pool tick: ${poolState.tick}`);
    if (poolPrice1Per0 != null) lines.push(`- current pool price token1/token0: ${fmtNum(poolPrice1Per0, { dp: 8 })}`);
    if (desiredRatio1Per0 != null) lines.push(`- desired ratio token1/token0: ${fmtNum(desiredRatio1Per0, { dp: 8 })}`);
    if (desiredVsPoolRatioPct != null) lines.push(`- desired vs pool ratio delta: ${fmtPct(desiredVsPoolRatioPct)}`);
    if (tickSpacing != null) {
      lines.push(`- pool tick spacing: ${tickSpacing}`);
      lines.push(`- tick alignment check: ${isTickAligned(dec.tickLower, tickSpacing) && isTickAligned(dec.tickUpper, tickSpacing) ? "PASS" : "FAIL"}`);
    }
    if (poolState) lines.push(`- in-range at current tick: ${inRangeAtBlock ? "YES" : "NO"}`);
    if (blockTs != null) {
      const deadlineCheck = analyzeDeadlineVsBlock(dec.deadline, blockTs);
      if (deadlineCheck) {
        lines.push(`- deadline vs tx block: ${deadlineCheck.pass ? "PASS" : "FAIL"} (${deadlineCheck.rendered})`);
        if (deadlineCheck.unitHint) lines.push(`- deadline unit hint: ${deadlineCheck.unitHint}`);
      }
    }
    lines.push(`- to == position manager: ${txToAddress === KITTENSWAP_CONTRACTS.positionManager ? "YES" : "NO"}`);
    lines.push(`- signer (tx.from): ${signerAddress}`);
    lines.push(`- manager allowance now for signer (${token0Meta?.symbol || dec.token0}): ${allow0NowSigner == null ? "n/a" : token0Meta ? formatUnits(allow0NowSigner, token0Meta.decimals, { precision: 8 }) : allow0NowSigner.toString()}`);
    lines.push(`- manager allowance now for signer (${token1Meta?.symbol || dec.token1}): ${allow1NowSigner == null ? "n/a" : token1Meta ? formatUnits(allow1NowSigner, token1Meta.decimals, { precision: 8 }) : allow1NowSigner.toString()}`);
    lines.push(`- wallet balance now for signer (${token0Meta?.symbol || dec.token0}): ${bal0NowSigner == null ? "n/a" : token0Meta ? formatUnits(bal0NowSigner, token0Meta.decimals, { precision: 8 }) : bal0NowSigner.toString()}`);
    lines.push(`- wallet balance now for signer (${token1Meta?.symbol || dec.token1}): ${bal1NowSigner == null ? "n/a" : token1Meta ? formatUnits(bal1NowSigner, token1Meta.decimals, { precision: 8 }) : bal1NowSigner.toString()}`);
    if (preTxBlockTag) {
      lines.push(`- manager allowance before tx block (N-1) for signer (${token0Meta?.symbol || dec.token0}): ${allow0BeforeSigner == null ? "n/a" : token0Meta ? formatUnits(allow0BeforeSigner, token0Meta.decimals, { precision: 8 }) : allow0BeforeSigner.toString()}`);
      lines.push(`- manager allowance before tx block (N-1) for signer (${token1Meta?.symbol || dec.token1}): ${allow1BeforeSigner == null ? "n/a" : token1Meta ? formatUnits(allow1BeforeSigner, token1Meta.decimals, { precision: 8 }) : allow1BeforeSigner.toString()}`);
      lines.push(`- wallet balance before tx block (N-1) for signer (${token0Meta?.symbol || dec.token0}): ${bal0BeforeSigner == null ? "n/a" : token0Meta ? formatUnits(bal0BeforeSigner, token0Meta.decimals, { precision: 8 }) : bal0BeforeSigner.toString()}`);
      lines.push(`- wallet balance before tx block (N-1) for signer (${token1Meta?.symbol || dec.token1}): ${bal1BeforeSigner == null ? "n/a" : token1Meta ? formatUnits(bal1BeforeSigner, token1Meta.decimals, { precision: 8 }) : bal1BeforeSigner.toString()}`);
    }
    if (ownerOverrideSupplied && owner !== signerAddress) {
      lines.push(`- manager allowance now for expected owner (${token0Meta?.symbol || dec.token0}): ${allow0NowExpected == null ? "n/a" : token0Meta ? formatUnits(allow0NowExpected, token0Meta.decimals, { precision: 8 }) : allow0NowExpected.toString()}`);
      lines.push(`- manager allowance now for expected owner (${token1Meta?.symbol || dec.token1}): ${allow1NowExpected == null ? "n/a" : token1Meta ? formatUnits(allow1NowExpected, token1Meta.decimals, { precision: 8 }) : allow1NowExpected.toString()}`);
    }
    lines.push(`- replay eth_call from tx sender @latest: ${replayLabel(replayAtLatest)}`);
    if (!replayAtLatest?.ok && replayAtLatest?.error) {
      lines.push(`- replay error @latest: ${replayAtLatest.error}`);
    }
    if (preTxBlockTag) {
      lines.push(`- replay eth_call from tx sender @block N-1: ${replayLabel(replayAtPre)}`);
      if (!replayAtPre?.ok && replayAtPre?.error) {
        lines.push(`- replay error @block N-1: ${replayAtPre.error}`);
      }
    }
    if (replayLatestMintDecoded?.ok) {
      lines.push(`- replay mint preview @latest: liquidity=${replayLatestMintDecoded.liquidity.toString()}, spend≈${token0Meta ? `${formatUnits(replayLatestMintDecoded.amount0, token0Meta.decimals, { precision: 8 })} ${token0Meta.symbol}` : replayLatestMintDecoded.amount0.toString()} + ${token1Meta ? `${formatUnits(replayLatestMintDecoded.amount1, token1Meta.decimals, { precision: 8 })} ${token1Meta.symbol}` : replayLatestMintDecoded.amount1.toString()}`);
    }

    const mintedTokenIds = statusLabel === "success"
      ? extractMintedPositionTokenIds(receipt, { positionManager: KITTENSWAP_CONTRACTS.positionManager, recipientAddress: dec.recipient })
      : [];
    if (mintedTokenIds.length) {
      lines.push(`- minted position tokenIds: ${mintedTokenIds.map((x) => x.toString()).join(", ")}`);
      if (mintedTokenIds.length === 1) {
        const mintedId = mintedTokenIds[0].toString();
        lines.push("- default continuation for this minted position (no extra prompt):");
        lines.push(`  - krlp farm-status ${mintedId} ${signerAddress}`);
        lines.push(`  - krlp farm-approve-plan ${mintedId} ${signerAddress}`);
        lines.push(`  - krlp farm-enter-plan ${mintedId} ${signerAddress} --auto-key`);
      }
    }

    if (statusLabel === "success") {
      const mintTransferRows = summarizeTransfersForAddress(receipt, signerAddress).filter((x) => x.sent > 0n || x.received > 0n);
      if (mintTransferRows.length) {
        const tokenMetaMap = await collectTokenMetaMap(mintTransferRows.map((x) => x.address));
        lines.push("- ERC20 transfer deltas for signer:");
        for (const row of mintTransferRows) {
          const meta = tokenMetaMap.get(row.address) || { symbol: "TOKEN", decimals: 18 };
          lines.push(`  - ${meta.symbol} (${row.address}) sent=${formatUnits(row.sent, meta.decimals, { precision: 8 })} received=${formatUnits(row.received, meta.decimals, { precision: 8 })} net=${formatUnits(row.net, meta.decimals, { precision: 8 })}`);
        }
      }
    }

    if (dec.amount0Desired === 0n || dec.amount1Desired === 0n) {
      lines.push("- BLOCKER: mint calldata has a zero desired amount.");
    }
    if (statusLabel !== "success") {
      if (txToAddress !== KITTENSWAP_CONTRACTS.positionManager) {
        lines.push("- BLOCKER: tx target is not Kittenswap position manager.");
      }
      if (ownerOverrideSupplied && owner !== signerAddress) {
        lines.push("- BLOCKER: signer mismatch. tx sender differs from expected owner; mint uses signer balances/allowances and can revert STF.");
      }
      if (allow0NowSigner != null && allow0NowSigner < dec.amount0Desired) {
        lines.push(`- BLOCKER: signer allowance for ${token0Meta?.symbol || dec.token0} is below amount0Desired.`);
      }
      if (allow1NowSigner != null && allow1NowSigner < dec.amount1Desired) {
        lines.push(`- BLOCKER: signer allowance for ${token1Meta?.symbol || dec.token1} is below amount1Desired.`);
      }
      if (bal0NowSigner != null && bal0NowSigner < dec.amount0Desired) {
        lines.push(`- BLOCKER: signer balance for ${token0Meta?.symbol || dec.token0} is below amount0Desired.`);
      }
      if (bal1NowSigner != null && bal1NowSigner < dec.amount1Desired) {
        lines.push(`- BLOCKER: signer balance for ${token1Meta?.symbol || dec.token1} is below amount1Desired.`);
      }
    } else {
      lines.push("- execution note: tx succeeded; current allowance/balance snapshots may differ after token spend/reset.");
    }
    if (
      statusLabel !== "success" &&
      preTxBlockTag &&
      allow0BeforeSigner != null &&
      allow1BeforeSigner != null &&
      allow0NowSigner != null &&
      allow1NowSigner != null &&
      (allow0BeforeSigner < dec.amount0Desired || allow1BeforeSigner < dec.amount1Desired) &&
      allow0NowSigner >= dec.amount0Desired &&
      allow1NowSigner >= dec.amount1Desired
    ) {
      lines.push("- likely root cause: approval race (allowance became sufficient only after this tx block).");
    }
    if (
      statusLabel !== "success" &&
      preTxBlockTag &&
      bal0BeforeSigner != null &&
      bal1BeforeSigner != null &&
      bal0NowSigner != null &&
      bal1NowSigner != null &&
      (bal0BeforeSigner < dec.amount0Desired || bal1BeforeSigner < dec.amount1Desired) &&
      bal0NowSigner >= dec.amount0Desired &&
      bal1NowSigner >= dec.amount1Desired
    ) {
      lines.push("- likely root cause: funding race (signer balances were insufficient at execution block).");
    }
    if (statusLabel !== "success" && inRangeAtBlock === false && dec.amount0Min > 0n && dec.amount1Min > 0n) {
      lines.push("- likely root cause: pool tick was outside selected range at execution; non-zero mins on both tokens can force a revert.");
      lines.push("- mitigation: widen tick range or loosen mins, then regenerate mint-plan right before signing.");
    }
    if (statusLabel !== "success" && selectedRangeZeroAnchored) {
      lines.push("- likely root cause: selected range appears anchored near tick 0 instead of current market tick.");
      lines.push("- mitigation: ticks are signed and can be negative; regenerate with --width-ticks N centered on live pool tick.");
    }
    const slippageRevertDetected = statusLabel !== "success" && (
      isPriceSlippageRevert(replayAtLatest?.revertHint) ||
      isPriceSlippageRevert(replayAtLatest?.error) ||
      isPriceSlippageRevert(replayAtPre?.revertHint) ||
      isPriceSlippageRevert(replayAtPre?.error)
    );
    if (slippageRevertDetected) {
      lines.push("- likely root cause: position-manager Price slippage check failed.");
      lines.push("- mitigation:");
      lines.push("  - re-run mint-plan immediately before signing and require direct simulation PASS.");
      lines.push("  - align desired token ratio closer to current pool ratio (swap inventory before mint).");
      lines.push("  - widen range and/or loosen mins with higher --slippage-bps for thin pools.");
      lines.push("  - avoid bypassing simulation; direct broadcast of failing calldata is unsafe.");
    }
    if (statusLabel !== "success") {
      if (gasUsed != null && gasUsed <= 30_000n) {
        lines.push("- likely class: fast-fail revert (very low gas used) from immediate validation/transfer checks.");
      }
      lines.push("- failure diagnostics:");
      lines.push("  - if replay from tx sender still reverts, calldata or signer state is invalid now.");
      lines.push("  - if replay now passes but tx failed, compare signer allowance/balance at N-1 vs now (race condition).");
      lines.push("  - use krlp mint-plan and ensure signer address exactly matches from address before signing.");
    }
    lines.push("- note: tx verify is read-only and does not execute transactions");
    return lines.join("\n");
  }

  lines.push("- decode: unsupported selector for custom decode");
  if (txTo === KITTENSWAP_CONTRACTS.positionManager && gasUsed != null && gasUsed <= 30_000n) {
    lines.push("- likely class: fast fallback/validation revert on position manager.");
    lines.push("- likely cause: unsupported selector or malformed calldata arguments.");
    lines.push("- expected farming approval selector/signature:");
    lines.push("  - 0x832f630a = approveForFarming(uint256,bool,address)");
    lines.push("- safe path: generate calldata via krlp farm-approve-plan <tokenId> [owner|label] and avoid manual encoding.");
  }
  if (multicallDecoded?.ok) {
    lines.push(`- multicall decode: ${multicallDecoded.variant}`);
    if (typeof multicallDecoded.deadline === "bigint") {
      lines.push(`- multicall deadline: ${multicallDecoded.deadline.toString()}`);
    }
    lines.push(`- multicall selectors: ${multicallDecoded.selectors.join(", ")}`);
  }
  lines.push("- note: for swap txs use krlp swap-verify <txHash>");
  lines.push("- note: tx verify is read-only and does not execute transactions");
  return lines.join("\n");
}

function usage() {
  return [
    'Usage: krlp "<command>"',
    "Commands:",
    "  health",
    "  contracts",
    "  account add <label> <address> [--default]",
    "  account list|remove|default ...",
    "  policy list|show [name]",
    "  policy set [name] [--edge-bps N] [--slippage-bps N] [--deadline-seconds N] [--default]",
    "  position <tokenId> [owner|label]",
    "  value|position-value <tokenId> [owner|label]",
    "  status <tokenId> [--edge-bps N]",
    "  wallet|portfolio [owner|label] [--active-only]",
    "  quote-swap|swap-quote <tokenIn> <tokenOut> --deployer <address> --amount-in <decimal>",
    "  swap-approve-plan <token> [owner|label] --amount <decimal|max> [--spender <address>] [--approve-max]",
    "  swap-plan <tokenIn> <tokenOut> --deployer <address> --amount-in <decimal> [owner|label] [--recipient <address|label>] [--policy <name>] [--slippage-bps N] [--deadline-seconds N] [--native-in] [--approve-max]",
    "  farm-status <tokenId> [owner|label] [--farming-center <address>] [--eternal-farming <address>]",
    "  farm-staked-summary [owner|label] [--active-only] [--farming-center <address>] [--eternal-farming <address>]",
    "  farm-approve-plan <tokenId> [owner|label] [--farming-center <address>] [--eternal-farming <address>]",
    "  farm-enter-plan <tokenId> [owner|label] [--auto-key | --reward-token <address> --bonus-reward-token <address> --pool <address> --nonce <N>] [--farming-center <address>] [--eternal-farming <address>]",
    "  farm-collect-plan <tokenId> [owner|label] [--auto-key | --reward-token <address> --bonus-reward-token <address> --pool <address> --nonce <N>] [--farming-center <address>] [--eternal-farming <address>]",
    "  farm-claim-plan <rewardToken> [owner|label] [--to <address|label>] --amount <decimal|max> [--farming-center <address>] [--eternal-farming <address>]",
    "  farm-exit-plan <tokenId> [owner|label] [--auto-key | --reward-token <address> --bonus-reward-token <address> --pool <address> --nonce <N>] [--farming-center <address>] [--eternal-farming <address>]",
    "  heartbeat|heartbeat-plan <tokenId> [owner|label] [--recipient <address|label>] [--policy <name>] [--edge-bps N] [--width-bump-ticks N] [--slippage-bps N] [--deadline-seconds N] [--farming-center <address>] [--eternal-farming <address>]",
    "  swap-verify <txHash> [owner|label]",
    "  mint-verify|verify-mint <txHash> [owner|label]",
    "  farm-verify|verify-farm <txHash> [owner|label]",
    "  tx-verify|verify-tx <txHash> [owner|label]",
    "  mint-plan|lp-mint-plan <tokenA> <tokenB> --amount-a <decimal> --amount-b <decimal> [owner|label] [--recipient <address|label>] [--deployer <address>] [--tick-lower N --tick-upper N | --width-ticks N --center-tick N] [--policy <name>] [--slippage-bps N] [--deadline-seconds N] [--approve-max] [--allow-out-of-range] [--no-auto-stake]",
    "  plan <tokenId> [owner|label] [--recipient <address|label>] [--policy <name>] [--edge-bps N] [--width-bump-ticks N] [--slippage-bps N] [--deadline-seconds N] [--amount0 <decimal> --amount1 <decimal>] [--allow-burn] [--no-auto-compound]",
    "  broadcast-raw <0xSignedTx> --yes SEND [--no-wait]",
    "  swap-broadcast <0xSignedTx> --yes SEND [--no-wait] (alias of broadcast-raw)",
    "",
    "Notes:",
    "  - chain: HyperEVM mainnet (id 999)",
    "  - rpc: https://rpc.hyperliquid.xyz/evm",
    `  - stable token aliases (swap commands): usdt/usdt0/usdc/usd/stable => ${DEFAULT_USD_STABLE_TOKEN}`,
    "  - output always prints full addresses/call data (no truncation).",
    "  - heartbeat default rebalance threshold: 500 bps (5%).",
    "  - heartbeat default widen-on-rebalance policy: +100 ticks.",
  ].join("\n");
}

async function runDeterministic(pref) {
  const tokens = tokenize(pref);
  const args = parseArgs(tokens);
  const cmd = String(args._[0] ?? "health").toLowerCase();

  if (cmd === "help" || cmd === "usage") return usage();
  if (cmd === "health" || cmd === "network") return cmdHealth();
  if (cmd === "contracts") return cmdContracts();
  if (cmd === "account") return cmdAccount(args);
  if (cmd === "policy") return cmdPolicy(args);

  if (cmd === "position") {
    const tokenIdRaw = args._[1];
    if (!tokenIdRaw) throw new Error("Usage: krlp position <tokenId> [owner|label]");
    return cmdPosition({ tokenIdRaw, ownerRef: args._[2] || "" });
  }

  if (cmd === "status") {
    const tokenIdRaw = args._[1];
    if (!tokenIdRaw) throw new Error("Usage: krlp status <tokenId> [--edge-bps N]");
    return cmdStatus({ tokenIdRaw, edgeBps: args["edge-bps"] });
  }

  if (cmd === "value" || cmd === "position-value" || cmd === "valuation") {
    const tokenIdRaw = args._[1];
    if (!tokenIdRaw) throw new Error("Usage: krlp value <tokenId> [owner|label]");
    return cmdValue({ tokenIdRaw, ownerRef: args._[2] || "" });
  }

  if (cmd === "wallet" || cmd === "portfolio" || cmd === "wallet-portfolio") {
    return cmdWallet({
      ownerRef: args._[1] || "",
      activeOnly: parseBoolFlag(args["active-only"]),
    });
  }

  if (cmd === "quote-swap" || cmd === "quote" || cmd === "swap-quote") {
    const tokenInRef = args._[1];
    const tokenOutRef = args._[2];
    const deployerRef = args.deployer;
    const amountInDecimal = args["amount-in"];
    if (!tokenInRef || !tokenOutRef || !deployerRef || !amountInDecimal) {
      throw new Error("Usage: krlp quote-swap <tokenIn> <tokenOut> --deployer <address> --amount-in <decimal>");
    }
    return cmdQuoteSwap({ tokenInRef, tokenOutRef, deployerRef, amountInDecimal });
  }

  if (cmd === "swap-approve-plan") {
    const tokenRef = args._[1];
    if (!tokenRef) {
      throw new Error("Usage: krlp swap-approve-plan <token> [owner|label] --amount <decimal|max> [--spender <address>] [--approve-max]");
    }
    if (!args.amount && !parseBoolFlag(args["approve-max"])) {
      throw new Error("Usage: krlp swap-approve-plan <token> [owner|label] --amount <decimal|max> [--spender <address>] [--approve-max]");
    }
    return cmdSwapApprovePlan({
      tokenRef,
      ownerRef: args._[2] || "",
      amountRef: args.amount,
      spenderRef: args.spender || "",
      approveMax: args["approve-max"],
    });
  }

  if (cmd === "swap-plan") {
    const tokenInRef = args._[1];
    const tokenOutRef = args._[2];
    const deployerRef = args.deployer;
    const amountInDecimal = args["amount-in"];
    if (!tokenInRef || !tokenOutRef || !deployerRef || !amountInDecimal) {
      throw new Error("Usage: krlp swap-plan <tokenIn> <tokenOut> --deployer <address> --amount-in <decimal> [owner|label] [--recipient <address|label>] [--policy <name>] [--slippage-bps N] [--deadline-seconds N] [--native-in] [--approve-max]");
    }
    return cmdSwapPlan({
      tokenInRef,
      tokenOutRef,
      deployerRef,
      amountInDecimal,
      ownerRef: args._[3] || "",
      recipientRef: args.recipient || "",
      policyRef: args.policy || "",
      slippageBps: args["slippage-bps"],
      deadlineSeconds: args["deadline-seconds"],
      limitSqrtPriceRef: args["limit-sqrt-price"],
      nativeIn: args["native-in"],
      approveMax: args["approve-max"],
    });
  }

  if (cmd === "farm-status") {
    const tokenIdRaw = args._[1];
    if (!tokenIdRaw) throw new Error("Usage: krlp farm-status <tokenId> [owner|label] [--farming-center <address>] [--eternal-farming <address>]");
    return cmdFarmStatus({
      tokenIdRaw,
      ownerRef: args._[2] || "",
      farmingCenterRef: args["farming-center"] || "",
      eternalFarmingRef: args["eternal-farming"] || "",
    });
  }

  if (cmd === "farm-staked-summary" || cmd === "farm-stake-summary" || cmd === "staked-status") {
    return cmdFarmStakedSummary({
      ownerRef: args._[1] || "",
      activeOnly: parseBoolFlag(args["active-only"]),
      farmingCenterRef: args["farming-center"] || "",
      eternalFarmingRef: args["eternal-farming"] || "",
    });
  }

  if (cmd === "farm-approve-plan") {
    const tokenIdRaw = args._[1];
    if (!tokenIdRaw) throw new Error("Usage: krlp farm-approve-plan <tokenId> [owner|label] [--farming-center <address>] [--eternal-farming <address>]");
    return cmdFarmApprovePlan({
      tokenIdRaw,
      ownerRef: args._[2] || "",
      farmingCenterRef: args["farming-center"] || "",
      eternalFarmingRef: args["eternal-farming"] || "",
      approve: true,
    });
  }

  if (cmd === "farm-enter-plan") {
    const tokenIdRaw = args._[1];
    if (!tokenIdRaw) {
      throw new Error("Usage: krlp farm-enter-plan <tokenId> [owner|label] [--auto-key | --reward-token <address> --bonus-reward-token <address> --pool <address> --nonce <N>] [--farming-center <address>] [--eternal-farming <address>]");
    }
    return cmdFarmEnterPlan({
      tokenIdRaw,
      ownerRef: args._[2] || "",
      rewardTokenRef: args["reward-token"] || "",
      bonusRewardTokenRef: args["bonus-reward-token"] || "",
      poolRef: args.pool || "",
      nonceRef: args.nonce || "",
      autoKey: args["auto-key"],
      farmingCenterRef: args["farming-center"] || "",
      eternalFarmingRef: args["eternal-farming"] || "",
    });
  }

  if (cmd === "farm-exit-plan") {
    const tokenIdRaw = args._[1];
    if (!tokenIdRaw) {
      throw new Error("Usage: krlp farm-exit-plan <tokenId> [owner|label] [--auto-key | --reward-token <address> --bonus-reward-token <address> --pool <address> --nonce <N>] [--farming-center <address>] [--eternal-farming <address>]");
    }
    return cmdFarmExitPlan({
      tokenIdRaw,
      ownerRef: args._[2] || "",
      rewardTokenRef: args["reward-token"] || "",
      bonusRewardTokenRef: args["bonus-reward-token"] || "",
      poolRef: args.pool || "",
      nonceRef: args.nonce || "",
      autoKey: args["auto-key"],
      farmingCenterRef: args["farming-center"] || "",
      eternalFarmingRef: args["eternal-farming"] || "",
    });
  }

  if (cmd === "farm-collect-plan") {
    const tokenIdRaw = args._[1];
    if (!tokenIdRaw) {
      throw new Error("Usage: krlp farm-collect-plan <tokenId> [owner|label] [--auto-key | --reward-token <address> --bonus-reward-token <address> --pool <address> --nonce <N>] [--farming-center <address>] [--eternal-farming <address>]");
    }
    return cmdFarmCollectPlan({
      tokenIdRaw,
      ownerRef: args._[2] || "",
      rewardTokenRef: args["reward-token"] || "",
      bonusRewardTokenRef: args["bonus-reward-token"] || "",
      poolRef: args.pool || "",
      nonceRef: args.nonce || "",
      autoKey: args["auto-key"],
      farmingCenterRef: args["farming-center"] || "",
      eternalFarmingRef: args["eternal-farming"] || "",
    });
  }

  if (cmd === "farm-claim-plan") {
    const rewardTokenRef = args._[1];
    if (!rewardTokenRef || !args.amount) {
      throw new Error("Usage: krlp farm-claim-plan <rewardToken> [owner|label] [--to <address|label>] --amount <decimal|max> [--farming-center <address>] [--eternal-farming <address>]");
    }
    return cmdFarmClaimPlan({
      rewardTokenRef,
      ownerRef: args._[2] || "",
      toRef: args.to || "",
      amountRef: args.amount,
      farmingCenterRef: args["farming-center"] || "",
      eternalFarmingRef: args["eternal-farming"] || "",
    });
  }

  if (cmd === "heartbeat" || cmd === "heartbeat-plan") {
    const tokenIdRaw = args._[1];
    if (!tokenIdRaw) {
      throw new Error("Usage: krlp heartbeat <tokenId> [owner|label] [--recipient <address|label>] [--policy <name>] [--edge-bps N] [--width-bump-ticks N] [--slippage-bps N] [--deadline-seconds N] [--farming-center <address>] [--eternal-farming <address>]");
    }
    return cmdHeartbeat({
      tokenIdRaw,
      ownerRef: args._[2] || "",
      recipientRef: args.recipient || "",
      policyRef: args.policy || "",
      edgeBps: args["edge-bps"],
      widthBumpTicks: args["width-bump-ticks"],
      slippageBps: args["slippage-bps"],
      deadlineSeconds: args["deadline-seconds"],
      farmingCenterRef: args["farming-center"] || "",
      eternalFarmingRef: args["eternal-farming"] || "",
    });
  }

  if (cmd === "swap-verify" || cmd === "verify-swap") {
    const txHashRef = args._[1];
    if (!txHashRef) throw new Error("Usage: krlp swap-verify <txHash> [owner|label]");
    return cmdSwapVerify({
      txHashRef,
      ownerRef: args._[2] || "",
    });
  }

  if (cmd === "mint-verify" || cmd === "verify-mint") {
    const txHashRef = args._[1];
    if (!txHashRef) throw new Error("Usage: krlp mint-verify <txHash> [owner|label]");
    return cmdTxVerify({
      txHashRef,
      ownerRef: args._[2] || "",
    });
  }

  if (cmd === "farm-verify" || cmd === "verify-farm") {
    const txHashRef = args._[1];
    if (!txHashRef) throw new Error("Usage: krlp farm-verify <txHash> [owner|label]");
    return cmdTxVerify({
      txHashRef,
      ownerRef: args._[2] || "",
    });
  }

  if (cmd === "tx-verify" || cmd === "verify-tx") {
    const txHashRef = args._[1];
    if (!txHashRef) throw new Error("Usage: krlp tx-verify <txHash> [owner|label]");
    return cmdTxVerify({
      txHashRef,
      ownerRef: args._[2] || "",
    });
  }

  if (cmd === "mint-plan" || cmd === "lp-mint-plan") {
    const tokenARef = args._[1];
    const tokenBRef = args._[2];
    const amountADecimal = args["amount-a"] ?? args.amount0 ?? args["amount0"];
    const amountBDecimal = args["amount-b"] ?? args.amount1 ?? args["amount1"];
    if (!tokenARef || !tokenBRef || !amountADecimal || !amountBDecimal) {
      throw new Error("Usage: krlp mint-plan <tokenA> <tokenB> --amount-a <decimal> --amount-b <decimal> [owner|label] [--recipient <address|label>] [--deployer <address>] [--tick-lower N --tick-upper N | --width-ticks N --center-tick N] [--policy <name>] [--slippage-bps N] [--deadline-seconds N] [--approve-max] [--allow-out-of-range] [--no-auto-stake]");
    }
    return cmdMintPlan({
      tokenARef,
      tokenBRef,
      deployerRef: args.deployer || "",
      amountADecimal,
      amountBDecimal,
      ownerRef: args._[3] || "",
      recipientRef: args.recipient || "",
      policyRef: args.policy || "",
      slippageBps: args["slippage-bps"],
      deadlineSeconds: args["deadline-seconds"],
      tickLowerRef: args["tick-lower"],
      tickUpperRef: args["tick-upper"],
      widthTicksRef: args["width-ticks"],
      centerTickRef: args["center-tick"],
      approveMax: args["approve-max"],
      allowOutOfRange: args["allow-out-of-range"],
      noAutoStake: args["no-auto-stake"],
    });
  }

  if (cmd === "plan") {
    const tokenIdRaw = args._[1];
    if (!tokenIdRaw) {
      throw new Error("Usage: krlp plan <tokenId> [owner|label] [--recipient <address|label>] [--policy <name>] [--edge-bps N] [--width-bump-ticks N] [--slippage-bps N] [--deadline-seconds N] [--amount0 x --amount1 y] [--allow-burn] [--no-auto-compound]");
    }
    return cmdPlan({
      tokenIdRaw,
      ownerRef: args._[2] || "",
      recipientRef: args.recipient || "",
      policyRef: args.policy || "",
      edgeBps: args["edge-bps"],
      widthBumpTicks: args["width-bump-ticks"],
      slippageBps: args["slippage-bps"],
      deadlineSeconds: args["deadline-seconds"],
      amount0Decimal: args.amount0,
      amount1Decimal: args.amount1,
      allowBurn: args["allow-burn"],
      noAutoCompound: args["no-auto-compound"],
    });
  }

  if (cmd === "broadcast-raw") {
    return cmdBroadcastRaw({
      signedTx: args._[1],
      yesToken: args.yes || "",
      wait: !parseBoolFlag(args["no-wait"]),
    });
  }

  if (cmd === "swap-broadcast" || cmd === "swap-execute") {
    return cmdBroadcastRaw({
      signedTx: args._[1],
      yesToken: args.yes || "",
      wait: !parseBoolFlag(args["no-wait"]),
    });
  }

  throw new Error(`Unknown command: ${cmd}`);
}

function guessIntentFromNL(raw) {
  const t = String(raw ?? "").toLowerCase();
  if (t.includes("heartbeat")) return { cmd: "heartbeat" };
  if ((t.includes("verify") || t.includes("receipt") || t.includes("tx")) && /0x[a-f0-9]{64}/.test(t)) return { cmd: "tx-verify" };
  if (t.includes("health") || t.includes("rpc") || t.includes("chain")) return { cmd: "health" };
  if (t.includes("contracts")) return { cmd: "contracts" };
  if (t.includes("staked status") || (t.includes("stake") && (t.includes("each") || t.includes("all")) && (t.includes("position") || t.includes("lp")))) {
    return { cmd: "farm-staked-summary" };
  }
  if (t.includes("farm") || t.includes("stake") || t.includes("farming")) return { cmd: "farm-status" };
  if (t.includes("wallet") || t.includes("portfolio")) return { cmd: "wallet" };
  if (t.includes("swap") && t.includes("quote")) return { cmd: "swap-quote" };
  if (t.includes("policy")) return { cmd: "policy show" };
  if (t.includes("swap") && t.includes("approve")) return { cmd: "swap-approve-plan" };
  if (t.includes("swap")) return { cmd: "swap-plan" };
  if (t.includes("mint") || (t.includes("lp") && t.includes("position"))) return { cmd: "mint-plan" };
  if ((t.includes("value") || t.includes("valuation")) && /\b\d+\b/.test(t)) return { cmd: "value" };
  if (t.includes("status") && /\b\d+\b/.test(t)) return { cmd: "status" };
  if ((t.includes("rebalance") || t.includes("plan")) && /\b\d+\b/.test(t)) return { cmd: "plan" };
  if (t.includes("position") && /\b\d+\b/.test(t)) return { cmd: "position" };
  return { cmd: "help" };
}

function firstInteger(text) {
  const m = String(text ?? "").match(/\b\d+\b/);
  return m ? m[0] : "";
}

function firstAddress(text) {
  const m = String(text ?? "").match(/(?:HL:)?0x[a-fA-F0-9]{40}/);
  return m ? m[0] : "";
}

function firstTxHash(text) {
  const m = String(text ?? "").match(/0x[a-fA-F0-9]{64}/);
  return m ? m[0] : "";
}

async function runNL(raw) {
  const guess = guessIntentFromNL(raw);
  if (guess.cmd === "health") return cmdHealth();
  if (guess.cmd === "contracts") return cmdContracts();
  if (guess.cmd === "farm-staked-summary") {
    return cmdFarmStakedSummary({
      ownerRef: firstAddress(raw),
      activeOnly: true,
      farmingCenterRef: "",
      eternalFarmingRef: "",
    });
  }
  if (guess.cmd === "farm-status") {
    const tokenIdRaw = firstInteger(raw);
    if (!tokenIdRaw) return usage();
    return cmdFarmStatus({ tokenIdRaw, ownerRef: firstAddress(raw) });
  }
  if (guess.cmd === "wallet") return cmdWallet({ ownerRef: firstAddress(raw), activeOnly: false });
  if (guess.cmd === "heartbeat") {
    const tokenIdRaw = firstInteger(raw);
    if (!tokenIdRaw) return usage();
    return cmdHeartbeat({
      tokenIdRaw,
      ownerRef: firstAddress(raw),
      recipientRef: "",
      policyRef: "",
      edgeBps: null,
      widthBumpTicks: null,
      slippageBps: null,
      deadlineSeconds: null,
      farmingCenterRef: "",
      eternalFarmingRef: "",
    });
  }
  if (guess.cmd === "tx-verify") return cmdTxVerify({ txHashRef: firstTxHash(raw), ownerRef: firstAddress(raw) });
  if (guess.cmd === "swap-quote") return usage();
  if (guess.cmd === "policy show") return cmdPolicy({ _: ["policy", "show"] });
  if (guess.cmd === "swap-approve-plan") return usage();
  if (guess.cmd === "swap-plan") return usage();
  if (guess.cmd === "mint-plan") return usage();
  if (guess.cmd === "value") return cmdValue({ tokenIdRaw: firstInteger(raw), ownerRef: firstAddress(raw) });
  if (guess.cmd === "status") return cmdStatus({ tokenIdRaw: firstInteger(raw), edgeBps: null });
  if (guess.cmd === "position") return cmdPosition({ tokenIdRaw: firstInteger(raw) });
  if (guess.cmd === "plan") {
    return cmdPlan({
      tokenIdRaw: firstInteger(raw),
      ownerRef: "",
      recipientRef: "",
      policyRef: "",
      edgeBps: null,
      widthBumpTicks: null,
      slippageBps: null,
      deadlineSeconds: null,
      amount0Decimal: null,
      amount1Decimal: null,
    });
  }
  return usage();
}

async function main() {
  const raw = process.argv.slice(2).join(" ").trim();
  if (!raw) {
    console.log(usage());
    process.exit(0);
  }

  const pref = stripPrefix(raw);
  const out = pref != null ? await runDeterministic(pref) : await runNL(raw);
  console.log(out);
  process.exit(0);
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
