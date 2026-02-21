#!/usr/bin/env node
// Command + NL interface for Kittenswap LP rebalance planning on HyperEVM.

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
  readPosition,
  readPoolAddressByPair,
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
const MIN_ALGEBRA_TICK = -887272;
const MAX_ALGEBRA_TICK = 887272;

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

function isRetryableRpcError(err) {
  const msg = String(err?.message || err || "");
  return /rate limit|too many requests|\b429\b|timeout|abort|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(msg);
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

function decodeExactInputSingleInput(inputHex) {
  const s = String(inputHex || "").toLowerCase();
  if (!s.startsWith("0x1679c792")) return null;
  const body = s.slice(10);
  if (body.length < 64 * 8) return null;
  const word = (i) => body.slice(i * 64, (i + 1) * 64);
  const addrWord = (i) => `0x${word(i).slice(24)}`.toLowerCase();
  const uintWord = (i) => hexToBigIntSafe(`0x${word(i)}`, 0n);
  return {
    tokenIn: addrWord(0),
    tokenOut: addrWord(1),
    deployer: addrWord(2),
    recipient: addrWord(3),
    deadline: uintWord(4),
    amountIn: uintWord(5),
    amountOutMinimum: uintWord(6),
    limitSqrtPrice: uintWord(7),
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

async function loadPositionValueSnapshot(tokenIdRaw, { ownerAddress }) {
  const tokenId = parseTokenId(tokenIdRaw);
  const ctx = await withRpcRetry(() => loadPositionContext(tokenId, { ownerAddress }));

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

  const widthTicks = ctx.position.tickUpper - ctx.position.tickLower;
  const ticksFromLower = ctx.poolState.tick - ctx.position.tickLower;
  const ticksToUpper = ctx.position.tickUpper - ctx.poolState.tick;
  const inRange = ctx.poolState.tick >= ctx.position.tickLower && ctx.poolState.tick < ctx.position.tickUpper;

  return {
    tokenId,
    ownerAddress,
    ctx,
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
  lines.push(`${prefix}  - pool: ${snap.ctx.poolAddress}`);
  lines.push(`${prefix}  - pair: ${token0.symbol} (${token0.address}) / ${token1.symbol} (${token1.address})`);
  lines.push(`${prefix}  - liquidity: ${snap.ctx.position.liquidity.toString()}`);
  lines.push(`${prefix}  - ticks: [${snap.range.lowerTick}, ${snap.range.upperTick}] | current ${snap.range.currentTick} | spacing ${snap.ctx.tickSpacing}`);
  lines.push(`${prefix}  - in range: ${snap.range.inRange ? "YES" : "NO"} | from lower ${snap.range.pctFromLower == null ? "n/a" : fmtPct(snap.range.pctFromLower)} | to upper ${snap.range.pctToUpper == null ? "n/a" : fmtPct(snap.range.pctToUpper)}`);
  lines.push(`${prefix}  - price token1/token0: current=${current1Per0 == null ? "n/a" : fmtNum(current1Per0, { dp: 8 })} lower=${lower1Per0 == null ? "n/a" : fmtNum(lower1Per0, { dp: 8 })} upper=${upper1Per0 == null ? "n/a" : fmtNum(upper1Per0, { dp: 8 })}`);
  lines.push(`${prefix}  - principal if burn now (simulated): ${snap.principalHuman.amount0 == null ? "n/a" : fmtNum(snap.principalHuman.amount0, { dp: 8 })} ${token0.symbol} + ${snap.principalHuman.amount1 == null ? "n/a" : fmtNum(snap.principalHuman.amount1, { dp: 8 })} ${token1.symbol}`);
  lines.push(`${prefix}  - claimable now via collect() (simulated): ${snap.claimableHuman.amount0 == null ? "n/a" : fmtNum(snap.claimableHuman.amount0, { dp: 8 })} ${token0.symbol} + ${snap.claimableHuman.amount1 == null ? "n/a" : fmtNum(snap.claimableHuman.amount1, { dp: 8 })} ${token1.symbol}`);
  lines.push(`${prefix}  - est value (in ${token1.symbol}): principal=${snap.valueInToken1.principal == null ? "n/a" : fmtNum(snap.valueInToken1.principal, { dp: 6 })} claimable=${snap.valueInToken1.claimable == null ? "n/a" : fmtNum(snap.valueInToken1.claimable, { dp: 6 })} total=${snap.valueInToken1.total == null ? "n/a" : fmtNum(snap.valueInToken1.total, { dp: 6 })}`);
  if (!snap.principal.ok && snap.principal.error) lines.push(`${prefix}  - principal simulation: error (${snap.principal.error})`);
  if (!snap.claimable.ok && snap.claimable.error) lines.push(`${prefix}  - claimable simulation: error (${snap.claimable.error})`);
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

function cmdContracts() {
  const lines = [];
  lines.push("Kittenswap contracts (HyperEVM mainnet)");
  for (const [k, v] of Object.entries(KITTENSWAP_CONTRACTS)) {
    lines.push(`- ${k}: ${v}`);
    lines.push(`  - explorer: ${addressLink(v)}`);
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

  const lines = [];
  lines.push(`Kittenswap LP position ${tokenId.toString()}`);
  lines.push(`- position manager: ${KITTENSWAP_CONTRACTS.positionManager}`);
  lines.push(`- nft owner: ${ctx.nftOwner}`);
  lines.push(`- token0: ${ctx.position.token0}`);
  lines.push(`- token1: ${ctx.position.token1}`);
  lines.push(`- deployer: ${ctx.position.deployer}`);
  lines.push(`- pool: ${ctx.poolAddress}`);
  lines.push(`- pool link: ${addressLink(ctx.poolAddress)}`);
  lines.push(`- liquidity: ${ctx.position.liquidity.toString()}`);
  lines.push(`- ticks: [${ctx.position.tickLower}, ${ctx.position.tickUpper}] | current ${ctx.poolState.tick} | spacing ${ctx.tickSpacing}`);
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
  lines.push(`- min headroom pct: ${headroomPct == null ? "n/a" : fmtPct(headroomPct)}`);
  lines.push(`- edge threshold: ${threshold} bps (${evald.edgeBufferTicks} ticks)`);
  lines.push(`- rebalance: ${evald.shouldRebalance ? "YES" : "NO"} (${evald.reason})`);
  lines.push(`- suggested new range: [${rec.tickLower}, ${rec.tickUpper}]`);
  lines.push(priceSection(ctx));
  return lines.join("\n");
}

async function cmdValue({ tokenIdRaw, ownerRef = "" }) {
  const tokenId = parseTokenId(tokenIdRaw);
  const ownerAddress = ownerRef
    ? await resolveAddressInput(ownerRef, { allowDefault: false })
    : await withRpcRetry(() => readOwnerOf(tokenId, { positionManager: KITTENSWAP_CONTRACTS.positionManager }));

  const snap = await loadPositionValueSnapshot(tokenId, { ownerAddress });
  const lines = [];
  lines.push(`Kittenswap LP valuation snapshot (${tokenId.toString()})`);
  lines.push(`- wallet (simulation from): ${ownerAddress}`);
  lines.push(`- position manager: ${KITTENSWAP_CONTRACTS.positionManager}`);
  lines.push(`- nft owner: ${snap.ctx.nftOwner}`);
  lines.push(`- pool link: ${addressLink(snap.ctx.poolAddress)}`);
  lines.push(`- method (principal): eth_call decreaseLiquidity(tokenId, fullLiquidity, 0, 0, deadline)`);
  lines.push(`- method (rewards): eth_call collect(tokenId, recipient, maxUint128, maxUint128)`);
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
      const snap = await loadPositionValueSnapshot(tokenId, { ownerAddress });
      snapshots.push(snap);
    } catch {
      rewardScanErrors += 1;
    }
  }

  const totalByQuoteToken = new Map();
  let totalWithValues = 0;
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
  lines.push("  - no signatures used; no transactions broadcast");

  if (totalWithValues < snapshots.length) {
    lines.push("- note: some position values were n/a due to simulation/read failures; review per-position error lines");
  }

  return lines.join("\n");
}

async function cmdQuoteSwap({ tokenInRef, tokenOutRef, deployerRef, amountInDecimal }) {
  const tokenIn = assertAddress(tokenInRef);
  const tokenOut = assertAddress(tokenOutRef);
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
  const token = assertAddress(tokenRef);
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
  const tokenIn = assertAddress(tokenInRef);
  const tokenOut = assertAddress(tokenOutRef);
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
  lines.push(`- token in: ${tokenInMeta.symbol} (${tokenInMeta.address})`);
  lines.push(`- token out: ${tokenOutMeta.symbol} (${tokenOutMeta.address})`);
  lines.push(`- amount in: ${formatUnits(amountIn, tokenInMeta.decimals, { precision: 8 })} ${tokenInMeta.symbol}`);
  lines.push(`- quoted amount out: ${formatUnits(quote.amountOut, tokenOutMeta.decimals, { precision: 8 })} ${tokenOutMeta.symbol}`);
  lines.push(`- minimum amount out: ${formatUnits(amountOutMin, tokenOutMeta.decimals, { precision: 8 })} ${tokenOutMeta.symbol}`);
  lines.push(`- quote fee tier: ${quote.fee}`);
  lines.push(`- quote ticks crossed: ${quote.initializedTicksCrossed}`);
  lines.push("- routing: single-hop exactInputSingle (multi-hop not enabled in this skill yet)");
  lines.push(`- policy: ${policyLoaded.key} (slippage=${effSlipBps}bps, deadline=${effDeadlineSec}s)`);
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
    }
    if (insufficientAllowance) {
      lines.push(`- BLOCKER: allowance is below amountIn for sender ${owner}`);
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
    } else {
      lines.push("- BLOCKER: direct swap simulation reverted; do not sign/send this swap until the blocker is resolved.");
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
  lines.push("  - stale calldata fails fast: if sent after deadline, contracts revert with 'Transaction too old' (often shown as silent revert)");
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
  let tickLower;
  let tickUpper;
  let rangeSource = "auto_centered";
  if (hasManualLower || hasManualUpper) {
    if (!hasManualLower || !hasManualUpper) {
      throw new Error("Provide both --tick-lower and --tick-upper, or neither.");
    }
    tickLower = parseInteger(tickLowerRef, { field: "tick-lower", min: MIN_ALGEBRA_TICK, max: MAX_ALGEBRA_TICK });
    tickUpper = parseInteger(tickUpperRef, { field: "tick-upper", min: MIN_ALGEBRA_TICK, max: MAX_ALGEBRA_TICK });
    rangeSource = "manual";
  } else {
    const widthRequested = parseOptionalInteger(widthTicksRef, 500, {
      field: "width-ticks",
      min: spacing * 2,
      max: MAX_ALGEBRA_TICK - MIN_ALGEBRA_TICK,
    });
    const centerTickRaw = parseOptionalInteger(centerTickRef, poolState.tick, {
      field: "center-tick",
      min: MIN_ALGEBRA_TICK,
      max: MAX_ALGEBRA_TICK,
    });
    const widthAligned = Math.max(spacing * 2, Math.ceil(widthRequested / spacing) * spacing);
    const centerAligned = alignTickNearest(centerTickRaw, spacing);
    tickLower = alignTickDown(centerAligned - Math.floor(widthAligned / 2), spacing);
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
  const directMintCall = await withRpcRetry(() => rpcCall(
    "eth_call",
    [{ from: owner, to: KITTENSWAP_CONTRACTS.positionManager, data: mintData, value: toHexQuantity(0n) }, "latest"]
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

  const gasPriceWei = gasPriceHex ? BigInt(gasPriceHex) : null;
  const totalGas = gasEstimates.reduce((acc, g) => (g.ok ? acc + g.gas : acc), 0n);
  const estFeeWei = gasPriceWei != null ? totalGas * gasPriceWei : null;

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
  lines.push(`- in-range at current tick: ${poolState.tick >= tickLower && poolState.tick < tickUpper ? "YES" : "NO"}`);
  lines.push(`- desired amounts: ${formatUnits(amount0Desired, token0Meta.decimals, { precision: 8 })} ${token0Meta.symbol} + ${formatUnits(amount1Desired, token1Meta.decimals, { precision: 8 })} ${token1Meta.symbol}`);
  lines.push(`- minimum amounts (slippage guard): ${formatUnits(amount0Min, token0Meta.decimals, { precision: 8 })} ${token0Meta.symbol} + ${formatUnits(amount1Min, token1Meta.decimals, { precision: 8 })} ${token1Meta.symbol}`);
  lines.push(`- policy: ${policyLoaded.key} (slippage=${effSlipBps}bps, deadline=${effDeadlineSec}s)`);
  lines.push(`- deadline unix: ${deadline.toString()}`);
  lines.push(`- deadline utc: ${deadlineIso}`);
  lines.push(`- deadline headroom now: ${deadlineHeadroomSec}s`);
  lines.push(`- wallet balances: ${token0Meta.balance == null ? "n/a" : `${formatUnits(token0Meta.balance, token0Meta.decimals, { precision: 8 })} ${token0Meta.symbol}`} | ${token1Meta.balance == null ? "n/a" : `${formatUnits(token1Meta.balance, token1Meta.decimals, { precision: 8 })} ${token1Meta.symbol}`}`);
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
  const mintSimLabel = directMintCall.ok
    ? "PASS"
    : directMintCall.category === "rpc_unavailable"
      ? "UNAVAILABLE (RPC timeout/rate-limit)"
      : `REVERT${directMintCall.revertHint ? ` (${directMintCall.revertHint})` : ""}`;
  lines.push(`- direct mint eth_call simulation: ${mintSimLabel}`);
  if (!directMintCall.ok && directMintCall.error) {
    lines.push(`- direct mint simulation error: ${directMintCall.error}`);
  }
  if (!directMintCall.ok) {
    if (directMintCall.category === "rpc_unavailable") {
      lines.push("- BLOCKER: mint preflight simulation is unavailable due RPC instability; re-run until simulation is PASS before signing.");
    } else {
      lines.push("- BLOCKER: direct mint simulation reverted; do not sign/send this mint until the blocker is resolved.");
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
  lines.push("  - stale calldata fails fast: if sent after deadline, contracts revert with 'Transaction too old' (often shown as silent revert)");
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
  slippageBps,
  deadlineSeconds,
  amount0Decimal,
  amount1Decimal,
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
  const rec = suggestCenteredRange({
    currentTick: ctx.poolState.tick,
    oldLower: ctx.position.tickLower,
    oldUpper: ctx.position.tickUpper,
    tickSpacing: ctx.tickSpacing,
  });

  const latestBlock = await rpcGetBlockByNumber("latest", false).catch(() => null);
  const nowTs = latestBlock?.timestamp ? Number(BigInt(latestBlock.timestamp)) : Math.floor(Date.now() / 1000);
  const deadline = BigInt(nowTs + effDeadlineSec);
  const deadlineIso = new Date((nowTs + effDeadlineSec) * 1000).toISOString();
  const deadlineHeadroomSec = effDeadlineSec;
  const uint128Max = maxUint128();

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
    { step: "burn_old_nft", to: KITTENSWAP_CONTRACTS.positionManager, data: burnData, value: 0n },
  ];
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
    ? await withRpcRetry(() => rpcCall(
      "eth_call",
      [{ from: owner, to: KITTENSWAP_CONTRACTS.positionManager, data: mintData, value: toHexQuantity(0n) }, "latest"]
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
      })
    : null;

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
  lines.push(`- decision: ${evald.shouldRebalance ? "REBALANCE" : "NO_REBALANCE"} (${evald.reason})`);
  lines.push(`- policy: ${policyLoaded.key} (edge=${effEdgeBps}bps, slippage=${effSlipBps}bps, deadline=${effDeadlineSec}s)`);
  lines.push(`- deadline unix: ${deadline.toString()}`);
  lines.push(`- deadline utc: ${deadlineIso}`);
  lines.push(`- deadline headroom now: ${deadlineHeadroomSec}s`);
  lines.push(`- wallet balances: ${ctx.token0.balance == null ? "n/a" : formatUnits(ctx.token0.balance, ctx.token0.decimals, { precision: 8 })} ${ctx.token0.symbol} | ${ctx.token1.balance == null ? "n/a" : formatUnits(ctx.token1.balance, ctx.token1.decimals, { precision: 8 })} ${ctx.token1.symbol}`);

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
        : `REVERT${directMintCall?.revertHint ? ` (${directMintCall.revertHint})` : ""}`;
    lines.push(`- direct mint eth_call simulation: ${rebalanceMintSimLabel}`);
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

  lines.push("- safety:");
  lines.push("  - output uses full addresses and full calldata; do not truncate or reconstruct");
  lines.push("  - dry-run only: this command does not sign or broadcast");
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

  const decodedSwap = decodeExactInputSingleInput(tx.input);
  const transferRows = summarizeTransfersForAddress(receipt, targetAddress);
  const tokenAddresses = new Set(transferRows.map((x) => x.address));
  if (decodedSwap?.tokenIn) tokenAddresses.add(decodedSwap.tokenIn);
  if (decodedSwap?.tokenOut) tokenAddresses.add(decodedSwap.tokenOut);
  const tokenMetaMap = await collectTokenMetaMap(tokenAddresses);

  const statusInt = receipt?.status == null ? null : Number.parseInt(receipt.status, 16);
  const statusLabel = statusInt == null ? "unknown" : statusInt === 1 ? "success" : "revert";
  const blockNumber = receipt?.blockNumber ? Number.parseInt(receipt.blockNumber, 16) : null;
  const gasUsed = receipt?.gasUsed ? hexToBigIntSafe(receipt.gasUsed, null) : null;
  const effectiveGasPrice = receipt?.effectiveGasPrice ? hexToBigIntSafe(receipt.effectiveGasPrice, null) : null;
  const txFeeWei = gasUsed != null && effectiveGasPrice != null ? gasUsed * effectiveGasPrice : null;
  const blockInfo = receipt?.blockNumber ? await rpcCall("eth_getBlockByNumber", [receipt.blockNumber, false]).catch(() => null) : null;
  const blockTs = blockInfo?.timestamp ? Number(BigInt(blockInfo.timestamp)) : null;

  const sentCandidates = transferRows.filter((x) => x.sent > 0n).sort((a, b) => (b.sent > a.sent ? 1 : -1));
  const recvCandidates = transferRows.filter((x) => x.received > 0n).sort((a, b) => (b.received > a.received ? 1 : -1));
  const inferredTokenIn = sentCandidates.length ? sentCandidates[0].address : null;
  const inferredTokenOut = recvCandidates.length ? recvCandidates[0].address : null;

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
    lines.push(`  - tokenIn: ${decodedSwap.tokenIn} (${tokenInMeta.symbol})`);
    lines.push(`  - tokenOut: ${decodedSwap.tokenOut} (${tokenOutMeta.symbol})`);
    lines.push(`  - deployer: ${decodedSwap.deployer}`);
    lines.push(`  - recipient: ${decodedSwap.recipient}`);
    lines.push(`  - amountIn: ${formatUnits(decodedSwap.amountIn, tokenInMeta.decimals, { precision: 8 })} ${tokenInMeta.symbol}`);
    lines.push(`  - minAmountOut: ${formatUnits(decodedSwap.amountOutMinimum, tokenOutMeta.decimals, { precision: 8 })} ${tokenOutMeta.symbol}`);
    lines.push(`  - deadline: ${decodedSwap.deadline.toString()}`);
    if (blockTs != null) {
      lines.push(`  - deadline vs tx block: ${decodedSwap.deadline > BigInt(blockTs) ? "PASS" : "FAIL"} (${decodedSwap.deadline.toString()} vs ${blockTs})`);
    }
  } else {
    lines.push("- calldata decode: not exactInputSingle (0x1679c792)");
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
    if (decodedSwap && blockTs != null && decodedSwap.deadline <= BigInt(blockTs)) {
      lines.push("- likely cause: swap deadline was expired at execution ('Transaction too old').");
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

  // For swap selector, reuse the richer swap verifier output.
  if (selector === "0x1679c792") {
    return cmdSwapVerify({ txHashRef: txHash, ownerRef });
  }

  const txFrom = normalizeAddress(tx.from || "");
  const txTo = normalizeAddress(tx.to || "");
  const owner = ownerRef
    ? await resolveAddressInput(ownerRef, { allowDefault: false })
    : (txFrom || assertAddress(tx.from));

  const statusInt = receipt?.status == null ? null : Number.parseInt(receipt.status, 16);
  const statusLabel = statusInt == null ? "pending" : statusInt === 1 ? "success" : "revert";
  const blockNumber = receipt?.blockNumber ? Number.parseInt(receipt.blockNumber, 16) : null;
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
  if (gasUsed != null) lines.push(`- gas used: ${gasUsed.toString()}`);
  if (effectiveGasPrice != null) lines.push(`- effective gas price: ${formatUnits(effectiveGasPrice, 9, { precision: 6 })} gwei`);
  if (txFeeWei != null) lines.push(`- tx fee: ${formatUnits(txFeeWei, 18, { precision: 10 })} HYPE`);
  if (blockTs != null) lines.push(`- block timestamp: ${blockTs}`);

  if (selector === "0x095ea7b3") {
    const dec = decodeApproveInput(tx.input);
    if (!dec) {
      lines.push("- decode: failed (approve calldata malformed)");
      return lines.join("\n");
    }
    const token = txTo || assertAddress(tx.to);
    const tokenMeta = await readTokenSnapshot(token, owner).catch(() => null);
    const allowanceNow = await readErc20Allowance(token, owner, dec.spender).catch(() => null);

    lines.push("- decoded approve calldata:");
    lines.push(`  - token: ${token}${tokenMeta ? ` (${tokenMeta.symbol})` : ""}`);
    lines.push(`  - owner: ${owner}`);
    lines.push(`  - spender: ${dec.spender}`);
    lines.push(`  - amount raw: ${dec.amount.toString()}`);
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
    lines.push("- note: approve decode is read-only and does not execute transactions");
    return lines.join("\n");
  }

  if (selector === "0xfe3f3be7") {
    const dec = decodeMintInput(tx.input);
    if (!dec) {
      lines.push("- decode: failed (mint calldata malformed)");
      return lines.join("\n");
    }
    const [token0Meta, token1Meta] = await Promise.all([
      readTokenSnapshot(dec.token0, owner).catch(() => null),
      readTokenSnapshot(dec.token1, owner).catch(() => null),
    ]);
    const poolAddress = await readPoolAddressByPair(dec.token0, dec.token1, { factory: KITTENSWAP_CONTRACTS.factory }).catch(() => null);
    const [poolState, tickSpacing] = poolAddress
      ? await Promise.all([
        readPoolGlobalState(poolAddress).catch(() => null),
        readPoolTickSpacing(poolAddress).catch(() => null),
      ])
      : [null, null];
    const [allow0, allow1] = await Promise.all([
      readErc20Allowance(dec.token0, owner, KITTENSWAP_CONTRACTS.positionManager).catch(() => null),
      readErc20Allowance(dec.token1, owner, KITTENSWAP_CONTRACTS.positionManager).catch(() => null),
    ]);
    const bal0 = token0Meta?.balance ?? null;
    const bal1 = token1Meta?.balance ?? null;

    lines.push("- decoded mint calldata:");
    lines.push(`  - token0: ${dec.token0}${token0Meta ? ` (${token0Meta.symbol})` : ""}`);
    lines.push(`  - token1: ${dec.token1}${token1Meta ? ` (${token1Meta.symbol})` : ""}`);
    lines.push(`  - deployer: ${dec.deployer}`);
    lines.push(`  - recipient: ${dec.recipient}`);
    lines.push(`  - ticks: [${dec.tickLower}, ${dec.tickUpper}]`);
    lines.push(`  - amount0Desired: ${token0Meta ? `${formatUnits(dec.amount0Desired, token0Meta.decimals, { precision: 8 })} ${token0Meta.symbol}` : dec.amount0Desired.toString()}`);
    lines.push(`  - amount1Desired: ${token1Meta ? `${formatUnits(dec.amount1Desired, token1Meta.decimals, { precision: 8 })} ${token1Meta.symbol}` : dec.amount1Desired.toString()}`);
    lines.push(`  - amount0Min: ${token0Meta ? `${formatUnits(dec.amount0Min, token0Meta.decimals, { precision: 8 })} ${token0Meta.symbol}` : dec.amount0Min.toString()}`);
    lines.push(`  - amount1Min: ${token1Meta ? `${formatUnits(dec.amount1Min, token1Meta.decimals, { precision: 8 })} ${token1Meta.symbol}` : dec.amount1Min.toString()}`);
    lines.push(`  - deadline: ${dec.deadline.toString()}`);
    lines.push(`- token order check (token0 < token1): ${dec.token0 < dec.token1 ? "PASS" : "FAIL"}`);
    lines.push(`- factory poolByPair(token0, token1): ${poolAddress || "not found"}`);
    if (poolState) lines.push(`- current pool tick: ${poolState.tick}`);
    if (tickSpacing != null) {
      lines.push(`- pool tick spacing: ${tickSpacing}`);
      lines.push(`- tick alignment check: ${isTickAligned(dec.tickLower, tickSpacing) && isTickAligned(dec.tickUpper, tickSpacing) ? "PASS" : "FAIL"}`);
    }
    if (poolState) {
      lines.push(`- in-range at current tick: ${poolState.tick >= dec.tickLower && poolState.tick < dec.tickUpper ? "YES" : "NO"}`);
    }
    if (blockTs != null) {
      lines.push(`- deadline vs tx block: ${dec.deadline > BigInt(blockTs) ? "PASS" : "FAIL"} (${dec.deadline.toString()} vs ${blockTs})`);
    }
    lines.push(`- manager allowance now (${token0Meta?.symbol || dec.token0}): ${allow0 == null ? "n/a" : token0Meta ? formatUnits(allow0, token0Meta.decimals, { precision: 8 }) : allow0.toString()}`);
    lines.push(`- manager allowance now (${token1Meta?.symbol || dec.token1}): ${allow1 == null ? "n/a" : token1Meta ? formatUnits(allow1, token1Meta.decimals, { precision: 8 }) : allow1.toString()}`);
    lines.push(`- wallet balance now (${token0Meta?.symbol || dec.token0}): ${bal0 == null ? "n/a" : token0Meta ? formatUnits(bal0, token0Meta.decimals, { precision: 8 }) : bal0.toString()}`);
    lines.push(`- wallet balance now (${token1Meta?.symbol || dec.token1}): ${bal1 == null ? "n/a" : token1Meta ? formatUnits(bal1, token1Meta.decimals, { precision: 8 }) : bal1.toString()}`);

    if (dec.amount0Desired === 0n || dec.amount1Desired === 0n) {
      lines.push("- BLOCKER: mint calldata has a zero desired amount.");
    }
    if (allow0 != null && allow0 < dec.amount0Desired) {
      lines.push(`- BLOCKER: allowance for ${token0Meta?.symbol || dec.token0} is below amount0Desired.`);
    }
    if (allow1 != null && allow1 < dec.amount1Desired) {
      lines.push(`- BLOCKER: allowance for ${token1Meta?.symbol || dec.token1} is below amount1Desired.`);
    }
    if (bal0 != null && bal0 < dec.amount0Desired) {
      lines.push(`- BLOCKER: balance for ${token0Meta?.symbol || dec.token0} is below amount0Desired.`);
    }
    if (bal1 != null && bal1 < dec.amount1Desired) {
      lines.push(`- BLOCKER: balance for ${token1Meta?.symbol || dec.token1} is below amount1Desired.`);
    }
    if (statusLabel !== "success") {
      lines.push("- failure diagnostics:");
      lines.push("  - if approvals were just sent, verify they were non-zero and mined before mint.");
      lines.push("  - if allowances are still zero, mint will revert even if approve tx status was success.");
      lines.push("  - if token order/ticks/deadline checks fail, regenerate mint plan.");
    }
    lines.push("- note: tx verify is read-only and does not execute transactions");
    return lines.join("\n");
  }

  lines.push("- decode: unsupported selector for custom decode");
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
    "  swap-verify <txHash> [owner|label]",
    "  tx-verify|verify-tx <txHash> [owner|label]",
    "  mint-plan|lp-mint-plan <tokenA> <tokenB> --amount-a <decimal> --amount-b <decimal> [owner|label] [--recipient <address|label>] [--deployer <address>] [--tick-lower N --tick-upper N | --width-ticks N --center-tick N] [--policy <name>] [--slippage-bps N] [--deadline-seconds N] [--approve-max]",
    "  plan <tokenId> [owner|label] [--recipient <address|label>] [--policy <name>] [--edge-bps N] [--slippage-bps N] [--deadline-seconds N] [--amount0 <decimal> --amount1 <decimal>]",
    "  broadcast-raw <0xSignedTx> --yes SEND [--no-wait]",
    "  swap-broadcast <0xSignedTx> --yes SEND [--no-wait] (alias of broadcast-raw)",
    "",
    "Notes:",
    "  - chain: HyperEVM mainnet (id 999)",
    "  - rpc: https://rpc.hyperliquid.xyz/evm",
    "  - output always prints full addresses/call data (no truncation).",
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

  if (cmd === "swap-verify" || cmd === "verify-swap") {
    const txHashRef = args._[1];
    if (!txHashRef) throw new Error("Usage: krlp swap-verify <txHash> [owner|label]");
    return cmdSwapVerify({
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
      throw new Error("Usage: krlp mint-plan <tokenA> <tokenB> --amount-a <decimal> --amount-b <decimal> [owner|label] [--recipient <address|label>] [--deployer <address>] [--tick-lower N --tick-upper N | --width-ticks N --center-tick N] [--policy <name>] [--slippage-bps N] [--deadline-seconds N] [--approve-max]");
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
    });
  }

  if (cmd === "plan") {
    const tokenIdRaw = args._[1];
    if (!tokenIdRaw) {
      throw new Error("Usage: krlp plan <tokenId> [owner|label] [--recipient <address|label>] [--amount0 x --amount1 y]");
    }
    return cmdPlan({
      tokenIdRaw,
      ownerRef: args._[2] || "",
      recipientRef: args.recipient || "",
      policyRef: args.policy || "",
      edgeBps: args["edge-bps"],
      slippageBps: args["slippage-bps"],
      deadlineSeconds: args["deadline-seconds"],
      amount0Decimal: args.amount0,
      amount1Decimal: args.amount1,
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
  if ((t.includes("verify") || t.includes("receipt") || t.includes("tx")) && /0x[a-f0-9]{64}/.test(t)) return { cmd: "tx-verify" };
  if (t.includes("health") || t.includes("rpc") || t.includes("chain")) return { cmd: "health" };
  if (t.includes("contracts")) return { cmd: "contracts" };
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
  if (guess.cmd === "wallet") return cmdWallet({ ownerRef: firstAddress(raw), activeOnly: false });
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
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
