// Kittenswap LP rebalance helpers for HyperEVM mainnet.
// Dependency-free RPC + ABI codec for deterministic planning output.

import { setTimeout as sleep } from "node:timers/promises";

export const DEFAULT_CHAIN_ID = String(process.env.HYPEREVM_CHAIN_ID || "999");
export const DEFAULT_RPC_URL = process.env.HYPEREVM_RPC_URL || "https://rpc.hyperliquid.xyz/evm";
export const DEFAULT_TIMEOUT_MS = Number(process.env.HYPEREVM_TIMEOUT_MS || 12_000);
export const DEFAULT_BROADCAST_TIMEOUT_MS = Number(process.env.HYPEREVM_BROADCAST_TIMEOUT_MS || 120_000);
export const DEFAULT_RPC_MAX_RETRIES = Number(process.env.HYPEREVM_RPC_MAX_RETRIES || 3);
export const DEFAULT_RPC_RETRY_BASE_MS = Number(process.env.HYPEREVM_RPC_RETRY_BASE_MS || 350);
export const DEFAULT_RPC_RETRY_MAX_MS = Number(process.env.HYPEREVM_RPC_RETRY_MAX_MS || 2_500);

export const KITTENSWAP_CONTRACTS = {
  factory: "0x5f95e92c338e6453111fc55ee66d4aafcce661a7",
  quoterV2: "0xc58874216afe47779aded27b8aad77e8bd6ebebb",
  router: "0x4e73e421480a7e0c24fb3c11019254ede194f736",
  positionManager: "0x9ea4459c8defbf561495d95414b9cf1e2242a3e2",
  farmingCenter: "0x211bd8917d433b7cc1f4497aba906554ab6ee479",
  eternalFarming: "0xf3b57fe4d5d0927c3a5e549cb6af1866687e2d62",
};

const SELECTOR = {
  ownerOf: "0x6352211e",
  tokenOfOwnerByIndex: "0x2f745c59",
  positions: "0x99fbab88",
  poolByPair: "0xd9a641e1",
  globalState: "0xe76c01e4",
  tickSpacing: "0xd0c93a7c",
  symbol: "0x95d89b41",
  name: "0x06fdde03",
  decimals: "0x313ce567",
  balanceOf: "0x70a08231",
  allowance: "0xdd62ed3e",
  approve: "0x095ea7b3",
  farmingCenter: "0xdd56e5d8",
  farmingApprovals: "0x2d0b22de",
  tokenFarmedIn: "0xe7ce18a3",
  approveForFarming: "0x832f630a",
  incentiveKeys: "0x57655846",
  deposits: "0xb02c43d0",
  enterFarming: "0x5739f0b9",
  exitFarming: "0x4473eca6",
  collectRewards: "0x6af00aee",
  claimReward: "0x2f2d783d",
  rewards: "0xe70b9e27",
  WNativeToken: "0x8af3ac85",
  quoteExactInputSingle: "0xe94764c4",
  exactInputSingle: "0x1679c792",
  collect: "0xfc6f7865",
  decreaseLiquidity: "0x0c49ccbe",
  burn: "0x42966c68",
  mint: "0xfe3f3be7",
};

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { controller, done: () => clearTimeout(timer) };
}

async function fetchJson(url, { method = "GET", headers, body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const { controller, done } = withTimeout(timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: headers || {},
      body,
      signal: controller.signal,
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
      err.httpStatus = res.status;
      throw err;
    }
    return text ? JSON.parse(text) : null;
  } finally {
    done();
  }
}

let _rpcIdCounter = 0;

function rpcRetryCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return Math.max(0, Math.floor(DEFAULT_RPC_MAX_RETRIES));
  return Math.max(0, Math.floor(n));
}

function rpcRetryDelay(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return Math.max(1, Math.floor(fallback));
  return Math.max(1, Math.floor(n));
}

function shouldRetryRpcError(error) {
  if (!error) return false;
  if (error?.name === "AbortError") return true;

  const status = Number(error?.httpStatus || 0);
  if ([408, 425, 429, 500, 502, 503, 504].includes(status)) return true;

  const rpcCode = Number(error?.rpcError?.code);
  const msg = String(error?.rpcError?.message || error?.message || "").toLowerCase();
  if (rpcCode === -32005) return true; // HyperEVM rate limited
  if (msg.includes("rate limit") || msg.includes("too many requests") || msg.includes("429")) return true;
  if (msg.includes("timeout") || msg.includes("timed out") || msg.includes("temporarily unavailable")) return true;
  if (msg.includes("fetch failed") || msg.includes("econnreset") || msg.includes("socket hang up")) return true;
  return false;
}

function backoffDelay(attempt, { baseMs, maxMs }) {
  const exp = Math.min(maxMs, baseMs * 2 ** attempt);
  const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(exp / 5)));
  return exp + jitter;
}

export async function rpcCall(
  method,
  params = [],
  {
    rpcUrl = DEFAULT_RPC_URL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRetries = DEFAULT_RPC_MAX_RETRIES,
    retryBaseMs = DEFAULT_RPC_RETRY_BASE_MS,
    retryMaxMs = DEFAULT_RPC_RETRY_MAX_MS,
  } = {}
) {
  const retries = rpcRetryCount(maxRetries);
  const baseMs = rpcRetryDelay(retryBaseMs, DEFAULT_RPC_RETRY_BASE_MS);
  const maxMs = Math.max(baseMs, rpcRetryDelay(retryMaxMs, DEFAULT_RPC_RETRY_MAX_MS));

  for (let attempt = 0; ; attempt++) {
    const payload = { jsonrpc: "2.0", id: ++_rpcIdCounter, method, params };
    try {
      const data = await fetchJson(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        timeoutMs,
      });
      if (data?.error) {
        const err = new Error(`RPC error: ${JSON.stringify(data.error)}`);
        err.rpcError = data.error;
        throw err;
      }
      return data?.result;
    } catch (error) {
      if (attempt >= retries || !shouldRetryRpcError(error)) throw error;
      await sleep(backoffDelay(attempt, { baseMs, maxMs }));
    }
  }
}

export async function rpcChainId(opts = {}) {
  const hex = await rpcCall("eth_chainId", [], opts);
  return { hex, decimal: Number.parseInt(hex, 16) };
}

export async function rpcBlockNumber(opts = {}) {
  const hex = await rpcCall("eth_blockNumber", [], opts);
  return { hex, decimal: Number.parseInt(hex, 16) };
}

export async function rpcGetBlockByNumber(tag = "latest", includeTx = false, opts = {}) {
  return rpcCall("eth_getBlockByNumber", [tag, includeTx], opts);
}

export async function rpcGasPrice(opts = {}) {
  return rpcCall("eth_gasPrice", [], opts);
}

export async function rpcEstimateGas(tx, opts = {}) {
  return rpcCall("eth_estimateGas", [tx], opts);
}

export async function rpcSendRawTransaction(rawTx, opts = {}) {
  const raw = String(rawTx ?? "").trim();
  if (!/^0x[0-9a-fA-F]+$/.test(raw)) throw new Error("Invalid signed tx payload. Expected 0x-prefixed hex.");
  if (raw.length < 120) throw new Error("Signed tx payload is too short. Provide full raw tx.");
  return rpcCall("eth_sendRawTransaction", [raw], opts);
}

export async function rpcGetTransactionReceipt(hash, opts = {}) {
  return rpcCall("eth_getTransactionReceipt", [assertTxHash(hash)], opts);
}

export async function waitForReceipt(hash, { rpcUrl = DEFAULT_RPC_URL, timeoutMs = DEFAULT_BROADCAST_TIMEOUT_MS, pollMs = 2_000 } = {}) {
  const txHash = assertTxHash(hash);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const receipt = await rpcGetTransactionReceipt(txHash, { rpcUrl });
    if (receipt) return receipt;
    await sleep(pollMs);
  }
  throw new Error(`Timed out waiting for receipt after ${Math.floor(timeoutMs / 1000)}s`);
}

export function receiptStatus(receipt) {
  if (!receipt?.status) return null;
  try {
    return Number.parseInt(receipt.status, 16) === 1;
  } catch {
    return null;
  }
}

function strip0x(hex) {
  return String(hex ?? "").replace(/^0x/i, "");
}

function ensureEvenHex(hex) {
  const s = strip0x(hex);
  return s.length % 2 === 0 ? s : `0${s}`;
}

function padToBytes(hexNoPrefix, bytes = 32) {
  return hexNoPrefix.padStart(bytes * 2, "0");
}

export function normalizeAddress(addr) {
  const m = String(addr ?? "").match(/(?:HL:)?(0x[a-fA-F0-9]{40})/);
  return m ? m[1].toLowerCase() : null;
}

export function assertAddress(addr) {
  const a = normalizeAddress(addr);
  if (!a) throw new Error("Invalid address. Expected HL:0x... or 0x... (40 hex chars).");
  return a;
}

export function normalizeTxHash(hash) {
  const m = String(hash ?? "").match(/(0x[a-fA-F0-9]{64})/);
  return m ? m[1].toLowerCase() : null;
}

export function assertTxHash(hash) {
  const h = normalizeTxHash(hash);
  if (!h) throw new Error("Invalid tx hash. Expected 0x + 64 hex chars.");
  return h;
}

export function shortAddress(addr) {
  const a = normalizeAddress(addr);
  if (!a) return String(addr ?? "");
  return `${a.slice(0, 8)}...${a.slice(-6)}`;
}

export function txLink(hash) {
  const h = normalizeTxHash(hash);
  return h ? `https://www.hyperscan.com/tx/${h}` : null;
}

export function addressLink(address) {
  const a = normalizeAddress(address);
  return a ? `https://www.hyperscan.com/address/${a}` : null;
}

function encodeUintWord(value) {
  const n = typeof value === "bigint" ? value : BigInt(String(value));
  if (n < 0n) throw new Error(`Unsigned value cannot be negative: ${value}`);
  return padToBytes(n.toString(16), 32);
}

function encodeIntWord(value, bits = 256) {
  const v = BigInt(String(value));
  const size = BigInt(bits);
  const max = (1n << (size - 1n)) - 1n;
  const min = -(1n << (size - 1n));
  if (v > max || v < min) throw new Error(`Signed value out of range for int${bits}: ${value}`);
  // ABI spec: int<M> values must be sign-extended to 256 bits, not M-bit two's complement.
  const twos = v < 0n ? (1n << 256n) + v : v;
  return padToBytes(twos.toString(16), 32);
}

function encodeAddressWord(address) {
  const a = assertAddress(address);
  return padToBytes(strip0x(a), 32);
}

function encodeBoolWord(value) {
  return encodeUintWord(value ? 1n : 0n);
}

function decodeWords(dataHex) {
  const hex = strip0x(dataHex);
  if (!hex) return [];
  if (hex.length % 64 !== 0) throw new Error(`Invalid ABI return length: ${hex.length}`);
  const out = [];
  for (let i = 0; i < hex.length; i += 64) out.push(hex.slice(i, i + 64));
  return out;
}

function wordToUint(wordHex) {
  return BigInt(`0x${wordHex || "0"}`);
}

function wordToAddress(wordHex) {
  const s = String(wordHex || "");
  if (s.length !== 64) return null;
  return `0x${s.slice(24)}`.toLowerCase();
}

function wordToInt(wordHex, bits = 256) {
  const raw = BigInt(`0x${wordHex || "0"}`);
  const size = BigInt(bits);
  const mask = (1n << size) - 1n;
  const x = raw & mask;
  const sign = 1n << (size - 1n);
  return (x & sign) !== 0n ? x - (1n << size) : x;
}

function wordToBool(wordHex) {
  return wordToUint(wordHex) !== 0n;
}

function wordToBytes32(wordHex) {
  const s = String(wordHex || "");
  if (s.length !== 64) return null;
  return `0x${s.toLowerCase()}`;
}

function decodeAbiString(dataHex) {
  const words = decodeWords(dataHex);
  if (!words.length) return "";
  const offset = Number(wordToUint(words[0]));
  const offsetWord = offset / 32;
  if (!Number.isInteger(offsetWord) || offsetWord + 1 >= words.length) return "";
  const len = Number(wordToUint(words[offsetWord]));
  if (!Number.isFinite(len) || len < 0) return "";
  const full = words.slice(offsetWord + 1).join("");
  const bytesHex = full.slice(0, len * 2);
  try {
    return Buffer.from(bytesHex, "hex").toString("utf8").replace(/\0+$/g, "").trim();
  } catch {
    return "";
  }
}

function decodeBytes32String(dataHex) {
  const words = decodeWords(dataHex);
  if (!words.length) return "";
  try {
    return Buffer.from(words[0], "hex").toString("utf8").replace(/\0+$/g, "").trim();
  } catch {
    return "";
  }
}

function encodeCallData(selector, encodedWords = []) {
  const body = encodedWords.join("");
  return `${selector}${body ? body : ""}`;
}

export async function rpcEthCall({ from = null, to, data, blockTag = "latest", rpcUrl = DEFAULT_RPC_URL } = {}) {
  const target = assertAddress(to);
  const payload = {
    to: target,
    data: String(data || "0x"),
  };
  if (from != null && String(from).trim()) payload.from = assertAddress(from);
  return rpcCall("eth_call", [payload, blockTag], { rpcUrl });
}

export async function readOwnerOf(tokenId, { positionManager = KITTENSWAP_CONTRACTS.positionManager, rpcUrl = DEFAULT_RPC_URL } = {}) {
  const data = encodeCallData(SELECTOR.ownerOf, [encodeUintWord(tokenId)]);
  const out = await rpcEthCall({ to: positionManager, data, rpcUrl });
  const words = decodeWords(out);
  if (!words.length) throw new Error("ownerOf returned empty response");
  const owner = wordToAddress(words[0]);
  if (!owner) throw new Error("ownerOf returned invalid address");
  return owner;
}

export async function readPositionManagerFarmingCenter(
  { positionManager = KITTENSWAP_CONTRACTS.positionManager, rpcUrl = DEFAULT_RPC_URL } = {}
) {
  const data = encodeCallData(SELECTOR.farmingCenter);
  const out = await rpcEthCall({ to: positionManager, data, rpcUrl });
  const w = decodeWords(out);
  if (!w.length) throw new Error("farmingCenter() returned empty response");
  const addr = wordToAddress(w[0]);
  if (!addr) throw new Error("farmingCenter() returned invalid address");
  return addr;
}

export async function readPositionFarmingApproval(
  tokenId,
  { positionManager = KITTENSWAP_CONTRACTS.positionManager, rpcUrl = DEFAULT_RPC_URL } = {}
) {
  const data = encodeCallData(SELECTOR.farmingApprovals, [encodeUintWord(tokenId)]);
  const out = await rpcEthCall({ to: positionManager, data, rpcUrl });
  const w = decodeWords(out);
  if (!w.length) throw new Error("farmingApprovals() returned empty response");
  const addr = wordToAddress(w[0]);
  if (!addr) throw new Error("farmingApprovals() returned invalid address");
  return addr;
}

export async function readTokenFarmedIn(
  tokenId,
  { positionManager = KITTENSWAP_CONTRACTS.positionManager, rpcUrl = DEFAULT_RPC_URL } = {}
) {
  const data = encodeCallData(SELECTOR.tokenFarmedIn, [encodeUintWord(tokenId)]);
  const out = await rpcEthCall({ to: positionManager, data, rpcUrl });
  const w = decodeWords(out);
  if (!w.length) throw new Error("tokenFarmedIn() returned empty response");
  const addr = wordToAddress(w[0]);
  if (!addr) throw new Error("tokenFarmedIn() returned invalid address");
  return addr;
}

export async function readPosition(tokenId, { positionManager = KITTENSWAP_CONTRACTS.positionManager, rpcUrl = DEFAULT_RPC_URL } = {}) {
  const data = encodeCallData(SELECTOR.positions, [encodeUintWord(tokenId)]);
  const out = await rpcEthCall({ to: positionManager, data, rpcUrl });
  const w = decodeWords(out);
  if (w.length < 12) throw new Error(`positions returned ${w.length} words (expected >=12)`);

  return {
    nonce: wordToUint(w[0]),
    operator: wordToAddress(w[1]),
    token0: wordToAddress(w[2]),
    token1: wordToAddress(w[3]),
    deployer: wordToAddress(w[4]),
    tickLower: Number(wordToInt(w[5], 24)),
    tickUpper: Number(wordToInt(w[6], 24)),
    liquidity: wordToUint(w[7]),
    feeGrowthInside0LastX128: wordToUint(w[8]),
    feeGrowthInside1LastX128: wordToUint(w[9]),
    tokensOwed0: wordToUint(w[10]),
    tokensOwed1: wordToUint(w[11]),
  };
}

export async function readPoolAddressByPair(tokenA, tokenB, { factory = KITTENSWAP_CONTRACTS.factory, rpcUrl = DEFAULT_RPC_URL } = {}) {
  const data = encodeCallData(SELECTOR.poolByPair, [encodeAddressWord(tokenA), encodeAddressWord(tokenB)]);
  const out = await rpcEthCall({ to: factory, data, rpcUrl });
  const words = decodeWords(out);
  const pool = words.length ? wordToAddress(words[0]) : null;
  if (!pool || pool === "0x0000000000000000000000000000000000000000") return null;
  return pool;
}

export async function readEternalFarmingIncentiveKey(
  poolAddress,
  { eternalFarming = KITTENSWAP_CONTRACTS.eternalFarming, rpcUrl = DEFAULT_RPC_URL } = {}
) {
  const data = encodeCallData(SELECTOR.incentiveKeys, [encodeAddressWord(poolAddress)]);
  const out = await rpcEthCall({ to: eternalFarming, data, rpcUrl });
  const w = decodeWords(out);
  if (w.length < 4) throw new Error(`incentiveKeys returned ${w.length} words (expected >=4)`);

  const rewardToken = wordToAddress(w[0]);
  const bonusRewardToken = wordToAddress(w[1]);
  const pool = wordToAddress(w[2]);
  if (!rewardToken || !bonusRewardToken || !pool) throw new Error("incentiveKeys returned invalid address field");

  return {
    rewardToken,
    bonusRewardToken,
    pool,
    nonce: wordToUint(w[3]),
  };
}

export async function readFarmingCenterDeposit(
  tokenId,
  { farmingCenter = KITTENSWAP_CONTRACTS.farmingCenter, rpcUrl = DEFAULT_RPC_URL } = {}
) {
  const data = encodeCallData(SELECTOR.deposits, [encodeUintWord(tokenId)]);
  const out = await rpcEthCall({ to: farmingCenter, data, rpcUrl });
  const w = decodeWords(out);
  if (!w.length) throw new Error("deposits() returned empty response");
  const incentiveId = wordToBytes32(w[0]);
  if (!incentiveId) throw new Error("deposits() returned invalid bytes32");
  return incentiveId;
}

export async function readEternalFarmingRewardBalance(
  ownerAddress,
  rewardToken,
  { eternalFarming = KITTENSWAP_CONTRACTS.eternalFarming, rpcUrl = DEFAULT_RPC_URL } = {}
) {
  const data = encodeCallData(SELECTOR.rewards, [encodeAddressWord(ownerAddress), encodeAddressWord(rewardToken)]);
  const out = await rpcEthCall({ to: eternalFarming, data, rpcUrl });
  const w = decodeWords(out);
  if (!w.length) return 0n;
  return wordToUint(w[0]);
}

export async function readPoolGlobalState(poolAddress, { rpcUrl = DEFAULT_RPC_URL } = {}) {
  const data = encodeCallData(SELECTOR.globalState);
  const out = await rpcEthCall({ to: poolAddress, data, rpcUrl });
  const w = decodeWords(out);
  if (w.length < 6) throw new Error(`globalState returned ${w.length} words (expected >=6)`);
  return {
    priceSqrtX96: wordToUint(w[0]),
    tick: Number(wordToInt(w[1], 24)),
    lastFee: Number(wordToUint(w[2])),
    pluginConfig: Number(wordToUint(w[3])),
    communityFee: Number(wordToUint(w[4])),
    unlocked: wordToBool(w[5]),
  };
}

export async function readPoolTickSpacing(poolAddress, { rpcUrl = DEFAULT_RPC_URL } = {}) {
  const data = encodeCallData(SELECTOR.tickSpacing);
  const out = await rpcEthCall({ to: poolAddress, data, rpcUrl });
  const w = decodeWords(out);
  if (!w.length) throw new Error("tickSpacing returned empty response");
  return Number(wordToInt(w[0], 24));
}

export async function readErc20Symbol(tokenAddress, { rpcUrl = DEFAULT_RPC_URL } = {}) {
  const out = await rpcEthCall({ to: tokenAddress, data: encodeCallData(SELECTOR.symbol), rpcUrl });
  const asString = decodeAbiString(out);
  if (asString) return asString;
  const asBytes32 = decodeBytes32String(out);
  return asBytes32 || "TOKEN";
}

export async function readErc20Name(tokenAddress, { rpcUrl = DEFAULT_RPC_URL } = {}) {
  const out = await rpcEthCall({ to: tokenAddress, data: encodeCallData(SELECTOR.name), rpcUrl });
  const asString = decodeAbiString(out);
  if (asString) return asString;
  const asBytes32 = decodeBytes32String(out);
  return asBytes32 || "Token";
}

export async function readErc20Decimals(tokenAddress, { rpcUrl = DEFAULT_RPC_URL } = {}) {
  const out = await rpcEthCall({ to: tokenAddress, data: encodeCallData(SELECTOR.decimals), rpcUrl });
  const w = decodeWords(out);
  if (!w.length) throw new Error("decimals returned empty response");
  return Number(wordToUint(w[0]));
}

export async function readErc20Balance(tokenAddress, ownerAddress, { rpcUrl = DEFAULT_RPC_URL, blockTag = "latest" } = {}) {
  const data = encodeCallData(SELECTOR.balanceOf, [encodeAddressWord(ownerAddress)]);
  const out = await rpcEthCall({ to: tokenAddress, data, blockTag, rpcUrl });
  const w = decodeWords(out);
  if (!w.length) return 0n;
  return wordToUint(w[0]);
}

export async function readErc20Allowance(
  tokenAddress,
  ownerAddress,
  spenderAddress,
  { rpcUrl = DEFAULT_RPC_URL, blockTag = "latest" } = {}
) {
  const data = encodeCallData(SELECTOR.allowance, [encodeAddressWord(ownerAddress), encodeAddressWord(spenderAddress)]);
  const out = await rpcEthCall({ to: tokenAddress, data, blockTag, rpcUrl });
  const w = decodeWords(out);
  if (!w.length) return 0n;
  return wordToUint(w[0]);
}

export async function readNftBalance(ownerAddress, { nftContract = KITTENSWAP_CONTRACTS.positionManager, rpcUrl = DEFAULT_RPC_URL } = {}) {
  const data = encodeCallData(SELECTOR.balanceOf, [encodeAddressWord(ownerAddress)]);
  const out = await rpcEthCall({ to: nftContract, data, rpcUrl });
  const w = decodeWords(out);
  if (!w.length) return 0n;
  return wordToUint(w[0]);
}

export async function readTokenOfOwnerByIndex(
  ownerAddress,
  index,
  { nftContract = KITTENSWAP_CONTRACTS.positionManager, rpcUrl = DEFAULT_RPC_URL } = {}
) {
  const data = encodeCallData(SELECTOR.tokenOfOwnerByIndex, [encodeAddressWord(ownerAddress), encodeUintWord(index)]);
  const out = await rpcEthCall({ to: nftContract, data, rpcUrl });
  const w = decodeWords(out);
  if (!w.length) throw new Error("tokenOfOwnerByIndex returned empty response");
  return wordToUint(w[0]);
}

export async function listOwnedTokenIds(ownerAddress, { positionManager = KITTENSWAP_CONTRACTS.positionManager, rpcUrl = DEFAULT_RPC_URL } = {}) {
  const balance = await readNftBalance(ownerAddress, { nftContract: positionManager, rpcUrl });
  if (balance === 0n) return [];
  const count = Number(balance);
  if (!Number.isSafeInteger(count) || count > 500) {
    throw new Error(`listOwnedTokenIds: wallet NFT balance ${balance.toString()} exceeds safe enumeration limit of 500`);
  }
  const indices = Array.from({ length: count }, (_, i) => BigInt(i));
  return Promise.all(indices.map((i) => readTokenOfOwnerByIndex(ownerAddress, i, { nftContract: positionManager, rpcUrl })));
}

export async function quoteExactInputSingle(
  { tokenIn, tokenOut, deployer, amountIn, limitSqrtPrice = 0n },
  { quoterV2 = KITTENSWAP_CONTRACTS.quoterV2, rpcUrl = DEFAULT_RPC_URL } = {}
) {
  const data = encodeCallData(SELECTOR.quoteExactInputSingle, [
    encodeAddressWord(tokenIn),
    encodeAddressWord(tokenOut),
    encodeAddressWord(deployer),
    encodeUintWord(amountIn),
    encodeUintWord(limitSqrtPrice),
  ]);
  const out = await rpcEthCall({ to: quoterV2, data, rpcUrl });
  const w = decodeWords(out);
  if (w.length < 6) throw new Error(`quoteExactInputSingle returned ${w.length} words (expected >=6)`);
  return {
    amountOut: wordToUint(w[0]),
    amountIn: wordToUint(w[1]),
    sqrtPriceX96After: wordToUint(w[2]),
    initializedTicksCrossed: Number(wordToUint(w[3])),
    gasEstimate: wordToUint(w[4]),
    fee: Number(wordToUint(w[5])),
  };
}

export function toHexQuantity(value) {
  const n = typeof value === "bigint" ? value : BigInt(String(value));
  if (n < 0n) throw new Error(`Negative hex quantity is invalid: ${value}`);
  return `0x${n.toString(16)}`;
}

export function formatUnits(raw, decimals = 18, { precision = 6 } = {}) {
  try {
    const d = Number.isFinite(Number(decimals)) ? Number(decimals) : 18;
    const n = BigInt(String(raw ?? "0"));
    const neg = n < 0n;
    const abs = neg ? -n : n;
    const base = 10n ** BigInt(d);
    const whole = abs / base;
    const frac = abs % base;
    if (precision <= 0 || d === 0) return `${neg ? "-" : ""}${whole.toString()}`;
    const fracStr = frac.toString().padStart(d, "0").slice(0, Math.min(d, precision)).replace(/0+$/, "");
    return `${neg ? "-" : ""}${whole.toString()}${fracStr ? `.${fracStr}` : ""}`;
  } catch {
    return String(raw ?? "");
  }
}

export function parseDecimalToUnits(amount, decimals = 18) {
  const s = String(amount ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Invalid decimal amount: ${amount}`);
  const [whole, frac = ""] = s.split(".");
  if (frac.length > decimals) throw new Error(`Too many decimal places for ${decimals}-decimals token`);
  const w = BigInt(whole || "0");
  const f = BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
  return w * 10n ** BigInt(decimals) + f;
}

export function tickToPrice(token1PerToken0Tick, { decimals0 = 18, decimals1 = 18 } = {}) {
  const t = Number(token1PerToken0Tick);
  if (!Number.isFinite(t)) return null;
  const ratio = Math.pow(1.0001, t);
  const scale = Math.pow(10, Number(decimals0) - Number(decimals1));
  const out = ratio * scale;
  return Number.isFinite(out) ? out : null;
}

export function alignTickDown(tick, spacing) {
  const s = Math.abs(Number(spacing || 1));
  if (!Number.isFinite(s) || s < 1) return Number(tick);
  const x = Number(tick);
  return Math.floor(x / s) * s;
}

export function alignTickNearest(tick, spacing) {
  const s = Math.abs(Number(spacing || 1));
  if (!Number.isFinite(s) || s < 1) return Number(tick);
  const x = Number(tick);
  return Math.round(x / s) * s;
}

export function evaluateRebalanceNeed({ currentTick, tickLower, tickUpper, edgeBps = 1500 } = {}) {
  const lower = Number(tickLower);
  const upper = Number(tickUpper);
  const cur = Number(currentTick);
  const width = upper - lower;
  if (!Number.isFinite(width) || width <= 0) {
    throw new Error(`Invalid tick range: [${tickLower}, ${tickUpper}]`);
  }

  const lowerHeadroom = cur - lower;
  const upperHeadroom = upper - cur;
  const minHeadroom = Math.min(lowerHeadroom, upperHeadroom);
  const edgeTicks = Math.floor((width * Math.max(0, Number(edgeBps))) / 10_000);
  const outOfRange = cur < lower || cur >= upper;
  const nearEdge = !outOfRange && minHeadroom <= edgeTicks;
  const shouldRebalance = outOfRange || nearEdge;

  return {
    widthTicks: width,
    lowerHeadroomTicks: lowerHeadroom,
    upperHeadroomTicks: upperHeadroom,
    edgeBufferTicks: edgeTicks,
    outOfRange,
    nearEdge,
    shouldRebalance,
    reason: outOfRange ? "out_of_range" : nearEdge ? "near_edge" : "healthy",
  };
}

export function suggestCenteredRange({ currentTick, oldLower, oldUpper, tickSpacing } = {}) {
  const lower = Number(oldLower);
  const upper = Number(oldUpper);
  const width = upper - lower;
  if (!Number.isFinite(width) || width <= 0) {
    throw new Error(`Invalid tick range: [${oldLower}, ${oldUpper}]`);
  }

  const spacing = Math.abs(Number(tickSpacing || 1));
  const center = alignTickNearest(currentTick, spacing);
  let nextLower = alignTickDown(center - Math.floor(width / 2), spacing);
  let nextUpper = nextLower + Math.ceil(width / spacing) * spacing;
  if (nextUpper <= nextLower) nextUpper = nextLower + spacing;
  return { tickLower: nextLower, tickUpper: nextUpper, widthTicks: nextUpper - nextLower };
}

export function buildCollectCalldata({ tokenId, recipient, amount0Max, amount1Max }) {
  return encodeCallData(SELECTOR.collect, [
    encodeUintWord(tokenId),
    encodeAddressWord(recipient),
    encodeUintWord(amount0Max),
    encodeUintWord(amount1Max),
  ]);
}

export function buildDecreaseLiquidityCalldata({ tokenId, liquidity, amount0Min = 0n, amount1Min = 0n, deadline }) {
  return encodeCallData(SELECTOR.decreaseLiquidity, [
    encodeUintWord(tokenId),
    encodeUintWord(liquidity),
    encodeUintWord(amount0Min),
    encodeUintWord(amount1Min),
    encodeUintWord(deadline),
  ]);
}

export function buildBurnCalldata({ tokenId }) {
  return encodeCallData(SELECTOR.burn, [encodeUintWord(tokenId)]);
}

export function buildMintCalldata({
  token0,
  token1,
  deployer,
  tickLower,
  tickUpper,
  amount0Desired,
  amount1Desired,
  amount0Min = 0n,
  amount1Min = 0n,
  recipient,
  deadline,
}) {
  return encodeCallData(SELECTOR.mint, [
    encodeAddressWord(token0),
    encodeAddressWord(token1),
    encodeAddressWord(deployer),
    encodeIntWord(tickLower, 24),
    encodeIntWord(tickUpper, 24),
    encodeUintWord(amount0Desired),
    encodeUintWord(amount1Desired),
    encodeUintWord(amount0Min),
    encodeUintWord(amount1Min),
    encodeAddressWord(recipient),
    encodeUintWord(deadline),
  ]);
}

export function buildApproveCalldata({ spender, amount }) {
  return encodeCallData(SELECTOR.approve, [encodeAddressWord(spender), encodeUintWord(amount)]);
}

export function buildApproveForFarmingCalldata({ tokenId, approve = true, farmingAddress }) {
  return encodeCallData(SELECTOR.approveForFarming, [
    encodeUintWord(tokenId),
    encodeBoolWord(approve),
    encodeAddressWord(farmingAddress),
  ]);
}

function encodeIncentiveKeyWords({ rewardToken, bonusRewardToken, pool, nonce }) {
  return [
    encodeAddressWord(rewardToken),
    encodeAddressWord(bonusRewardToken),
    encodeAddressWord(pool),
    encodeUintWord(nonce),
  ];
}

export function buildFarmingEnterCalldata({ rewardToken, bonusRewardToken, pool, nonce, tokenId }) {
  return encodeCallData(SELECTOR.enterFarming, [
    ...encodeIncentiveKeyWords({ rewardToken, bonusRewardToken, pool, nonce }),
    encodeUintWord(tokenId),
  ]);
}

export function buildFarmingExitCalldata({ rewardToken, bonusRewardToken, pool, nonce, tokenId }) {
  return encodeCallData(SELECTOR.exitFarming, [
    ...encodeIncentiveKeyWords({ rewardToken, bonusRewardToken, pool, nonce }),
    encodeUintWord(tokenId),
  ]);
}

export function buildFarmingCollectRewardsCalldata({ rewardToken, bonusRewardToken, pool, nonce, tokenId }) {
  return encodeCallData(SELECTOR.collectRewards, [
    ...encodeIncentiveKeyWords({ rewardToken, bonusRewardToken, pool, nonce }),
    encodeUintWord(tokenId),
  ]);
}

export function buildFarmingClaimRewardCalldata({ rewardToken, to, amountRequested }) {
  return encodeCallData(SELECTOR.claimReward, [
    encodeAddressWord(rewardToken),
    encodeAddressWord(to),
    encodeUintWord(amountRequested),
  ]);
}

export function buildSwapExactInputSingleCalldata({
  tokenIn,
  tokenOut,
  deployer,
  recipient,
  deadline,
  amountIn,
  amountOutMinimum,
  limitSqrtPrice = 0n,
}) {
  return encodeCallData(SELECTOR.exactInputSingle, [
    encodeAddressWord(tokenIn),
    encodeAddressWord(tokenOut),
    encodeAddressWord(deployer),
    encodeAddressWord(recipient),
    encodeUintWord(deadline),
    encodeUintWord(amountIn),
    encodeUintWord(amountOutMinimum),
    encodeUintWord(limitSqrtPrice),
  ]);
}

export function decodeTwoUint256Return(dataHex, { label = "call" } = {}) {
  const words = decodeWords(dataHex);
  if (words.length < 2) {
    throw new Error(`${label} returned ${words.length} words (expected >=2)`);
  }
  return {
    amount0: wordToUint(words[0]),
    amount1: wordToUint(words[1]),
  };
}

export async function simulateCollect(
  {
    tokenId,
    recipient,
    fromAddress,
    amount0Max = maxUint128(),
    amount1Max = maxUint128(),
    positionManager = KITTENSWAP_CONTRACTS.positionManager,
  },
  { rpcUrl = DEFAULT_RPC_URL, blockTag = "latest" } = {}
) {
  const data = buildCollectCalldata({ tokenId, recipient, amount0Max, amount1Max });
  const out = await rpcEthCall({
    from: fromAddress,
    to: positionManager,
    data,
    blockTag,
    rpcUrl,
  });
  const decoded = decodeTwoUint256Return(out, { label: "collect" });
  return { ...decoded, data, returnData: out };
}

export async function simulateDecreaseLiquidity(
  {
    tokenId,
    liquidity,
    deadline,
    fromAddress,
    amount0Min = 0n,
    amount1Min = 0n,
    positionManager = KITTENSWAP_CONTRACTS.positionManager,
  },
  { rpcUrl = DEFAULT_RPC_URL, blockTag = "latest" } = {}
) {
  const data = buildDecreaseLiquidityCalldata({
    tokenId,
    liquidity,
    amount0Min,
    amount1Min,
    deadline,
  });
  const out = await rpcEthCall({
    from: fromAddress,
    to: positionManager,
    data,
    blockTag,
    rpcUrl,
  });
  const decoded = decodeTwoUint256Return(out, { label: "decreaseLiquidity" });
  return { ...decoded, data, returnData: out };
}

export async function readRouterWNativeToken({ router = KITTENSWAP_CONTRACTS.router, rpcUrl = DEFAULT_RPC_URL } = {}) {
  const out = await rpcEthCall({ to: router, data: encodeCallData(SELECTOR.WNativeToken), rpcUrl });
  const w = decodeWords(out);
  if (!w.length) throw new Error("WNativeToken() returned empty response");
  const addr = wordToAddress(w[0]);
  if (!addr) throw new Error("WNativeToken() returned invalid address");
  return addr;
}

export async function rpcGetNativeBalance(address, { rpcUrl = DEFAULT_RPC_URL, blockTag = "latest" } = {}) {
  const addr = assertAddress(address);
  const hex = await rpcCall("eth_getBalance", [addr, blockTag], { rpcUrl });
  return hex ? BigInt(hex) : 0n;
}

export async function estimateCallGas({ from, to, data, value = 0n }, { rpcUrl = DEFAULT_RPC_URL } = {}) {
  try {
    const gasHex = await rpcEstimateGas(
      {
        from: assertAddress(from),
        to: assertAddress(to),
        data,
        value: toHexQuantity(value),
      },
      { rpcUrl }
    );
    return { ok: true, gasHex, gas: BigInt(gasHex) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export function maxUint128() {
  return (1n << 128n) - 1n;
}

export function parseTokenId(input) {
  const s = String(input ?? "").trim();
  if (!/^\d+$/.test(s)) throw new Error(`Invalid token id: ${input}`);
  return BigInt(s);
}

export function parseBps(input, fallback, { min = 0, max = 10_000 } = {}) {
  const n = Number(input);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function parseSeconds(input, fallback, { min = 1, max = 86_400 } = {}) {
  const n = Number(input);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function parsePositiveDecimal(input, { field = "amount" } = {}) {
  const s = String(input ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Invalid ${field}: ${input}`);
  if (Number(s) <= 0) throw new Error(`${field} must be > 0`);
  return s;
}
