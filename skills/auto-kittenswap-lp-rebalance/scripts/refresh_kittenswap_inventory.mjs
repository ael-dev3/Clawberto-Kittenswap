#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CHAIN_ID,
  DEFAULT_RPC_URL,
  KITTENSWAP_CONTRACTS,
  normalizeAddress,
  readErc20Decimals,
  readErc20Name,
  readErc20Symbol,
  readPoolGlobalState,
  readPoolTickSpacing,
  rpcBlockNumber,
} from "./kittenswap_rebalance_api.mjs";

const HYPERSCAN_API_V2 = process.env.HYPERSCAN_API_V2 || "https://www.hyperscan.com/api/v2";
const FACTORY = KITTENSWAP_CONTRACTS.factory.toLowerCase();
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const MAX_RETRIES = 5;
const RETRY_BASE_MS = 400;
const DEFAULT_CONCURRENCY = 8;
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 16;
const CONCURRENCY = clampInt(process.env.KITTENSWAP_ENUM_CONCURRENCY, DEFAULT_CONCURRENCY, MIN_CONCURRENCY, MAX_CONCURRENCY);
const METHOD_ID_POOL = "91ccaa7a";
const METHOD_ID_CUSTOM_POOL = "2b27bded";

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultJsonPath = resolve(__dirname, "../references/kittenswap-token-pair-inventory.json");
const defaultMarkdownPath = resolve(__dirname, "../references/kittenswap-token-pair-inventory.md");
const outputJsonPath = process.argv[2] ? resolve(process.cwd(), process.argv[2]) : defaultJsonPath;
const outputMarkdownPath = process.argv[3] ? resolve(process.cwd(), process.argv[3]) : defaultMarkdownPath;

const KNOWN_TOKEN_ALIASES = new Map([
  ["0x5555555555555555555555555555555555555555", "WHYPE"],
  ["0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb", "USD stablecoin"],
]);

async function main() {
  const startedAt = new Date();
  const [{ events, pageCount }, latestBlock] = await Promise.all([
    fetchFactoryPoolEvents(),
    safe(async () => rpcBlockNumber({ rpcUrl: DEFAULT_RPC_URL })),
  ]);

  const uniquePools = dedupePools(events);
  const tokenAddresses = collectUniqueTokenAddresses(uniquePools);
  const [tokenMetaMap, poolMetaMap] = await Promise.all([
    fetchTokenMetadata(tokenAddresses),
    fetchPoolMetadata(uniquePools.map((x) => x.pool)),
  ]);

  const enrichedPools = uniquePools.map((row) => {
    const token0Meta = tokenMetaMap.get(row.token0) || defaultTokenMeta(row.token0);
    const token1Meta = tokenMetaMap.get(row.token1) || defaultTokenMeta(row.token1);
    const poolMeta = poolMetaMap.get(row.pool) || defaultPoolMeta();
    return {
      ...row,
      token0Symbol: token0Meta.symbol,
      token1Symbol: token1Meta.symbol,
      token0Decimals: token0Meta.decimals,
      token1Decimals: token1Meta.decimals,
      tickSpacing: poolMeta.tickSpacing,
      currentTick: poolMeta.currentTick,
      poolMetaError: poolMeta.error,
    };
  });

  const tokenRows = buildTokenRows(enrichedPools, tokenMetaMap);
  const payload = {
    generatedAt: new Date().toISOString(),
    generatedAtUnixMs: Date.now(),
    startedAt: startedAt.toISOString(),
    chainId: Number(DEFAULT_CHAIN_ID),
    rpcUrl: DEFAULT_RPC_URL,
    source: {
      hyperscanApiV2: HYPERSCAN_API_V2,
      factoryLogsEndpoint: `${HYPERSCAN_API_V2}/addresses/${FACTORY}/logs`,
    },
    coreContracts: {
      factory: KITTENSWAP_CONTRACTS.factory,
      quoterV2: KITTENSWAP_CONTRACTS.quoterV2,
      router: KITTENSWAP_CONTRACTS.router,
      positionManager: KITTENSWAP_CONTRACTS.positionManager,
    },
    stats: {
      latestBlock: latestBlock.ok ? latestBlock.value.decimal : null,
      latestBlockHex: latestBlock.ok ? latestBlock.value.hex : null,
      hyperscanPagesRead: pageCount,
      poolEventsRead: events.length,
      uniquePools: enrichedPools.length,
      defaultPools: enrichedPools.filter((x) => x.eventType === "Pool").length,
      customPools: enrichedPools.filter((x) => x.eventType === "CustomPool").length,
      uniqueTokens: tokenRows.length,
    },
    tokens: tokenRows,
    pairs: enrichedPools,
  };

  await writeOutputFiles(payload, outputJsonPath, outputMarkdownPath);

  console.log("KittenSwap inventory refresh complete.");
  console.log(`- output json: ${outputJsonPath}`);
  console.log(`- output md:   ${outputMarkdownPath}`);
  console.log(`- pools: ${payload.stats.uniquePools}`);
  console.log(`- tokens: ${payload.stats.uniqueTokens}`);
  if (!latestBlock.ok) console.log(`- latest block lookup: unavailable (${latestBlock.error})`);
}

function clampInt(raw, fallback, min, max) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function sleep(ms) {
  return new Promise((resolveFn) => setTimeout(resolveFn, ms));
}

function toQuery(obj) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(obj || {})) {
    if (v == null || v === "") continue;
    params.set(k, String(v));
  }
  return params.toString();
}

async function fetchJson(url, { retries = MAX_RETRIES } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { method: "GET", headers: { Accept: "application/json" } });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
      return text ? JSON.parse(text) : null;
    } catch (err) {
      lastErr = err;
      if (attempt >= retries) break;
      await sleep(RETRY_BASE_MS * Math.pow(2, attempt));
    }
  }
  throw lastErr || new Error(`Failed to fetch JSON from ${url}`);
}

function parsePoolEvent(logItem) {
  const decoded = logItem?.decoded;
  if (!decoded) return null;
  const methodCall = String(decoded.method_call || "");
  const methodId = String(decoded.method_id || "").toLowerCase();
  const parameters = Array.isArray(decoded.parameters) ? decoded.parameters : [];
  const kv = {};
  for (const p of parameters) kv[String(p?.name || "")] = p?.value;

  if (methodCall.startsWith("Pool(") || methodId === METHOD_ID_POOL) {
    const token0 = normalizeAddress(kv.token0);
    const token1 = normalizeAddress(kv.token1);
    const pool = normalizeAddress(kv.pool);
    if (!token0 || !token1 || !pool) return null;
    return {
      eventType: "Pool",
      deployer: ZERO_ADDRESS,
      token0,
      token1,
      pool,
      blockNumber: Number(logItem?.block_number || 0),
      txHash: String(logItem?.transaction_hash || "").toLowerCase(),
      logIndex: Number(logItem?.index || 0),
    };
  }

  if (methodCall.startsWith("CustomPool(") || methodId === METHOD_ID_CUSTOM_POOL) {
    const deployer = normalizeAddress(kv.deployer);
    const token0 = normalizeAddress(kv.token0);
    const token1 = normalizeAddress(kv.token1);
    const pool = normalizeAddress(kv.pool);
    if (!deployer || !token0 || !token1 || !pool) return null;
    return {
      eventType: "CustomPool",
      deployer,
      token0,
      token1,
      pool,
      blockNumber: Number(logItem?.block_number || 0),
      txHash: String(logItem?.transaction_hash || "").toLowerCase(),
      logIndex: Number(logItem?.index || 0),
    };
  }

  return null;
}

async function fetchFactoryPoolEvents() {
  const items = [];
  let nextPageParams = null;
  let pageCount = 0;

  do {
    const query = nextPageParams ? `?${toQuery(nextPageParams)}` : "";
    const url = `${HYPERSCAN_API_V2}/addresses/${FACTORY}/logs${query}`;
    const page = await fetchJson(url);
    pageCount += 1;
    const logs = Array.isArray(page?.items) ? page.items : [];
    for (const logItem of logs) {
      const parsed = parsePoolEvent(logItem);
      if (parsed) items.push(parsed);
    }
    nextPageParams = page?.next_page_params || null;
  } while (nextPageParams);

  // API pages are newest -> oldest; reverse for deterministic oldest-first output.
  items.sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
    if (a.logIndex !== b.logIndex) return a.logIndex - b.logIndex;
    return a.pool.localeCompare(b.pool);
  });

  return { events: items, pageCount };
}

function dedupePools(events) {
  const seen = new Map();
  for (const row of events) {
    const key = row.pool;
    if (!seen.has(key)) {
      seen.set(key, { ...row });
      continue;
    }
    const prev = seen.get(key);
    // Keep the earliest creation-like entry.
    if (row.blockNumber < prev.blockNumber || (row.blockNumber === prev.blockNumber && row.logIndex < prev.logIndex)) {
      seen.set(key, { ...row });
    }
  }
  return [...seen.values()].sort((a, b) => {
    if (a.token0 !== b.token0) return a.token0.localeCompare(b.token0);
    if (a.token1 !== b.token1) return a.token1.localeCompare(b.token1);
    return a.pool.localeCompare(b.pool);
  });
}

function collectUniqueTokenAddresses(pairs) {
  const out = new Set();
  for (const row of pairs) {
    out.add(row.token0);
    out.add(row.token1);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

async function mapConcurrent(values, limit, worker) {
  if (!values.length) return [];
  const results = new Array(values.length);
  let cursor = 0;

  async function run() {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      results[index] = await worker(values[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(limit, values.length) }, () => run());
  await Promise.all(workers);
  return results;
}

function defaultTokenMeta(address) {
  return {
    address,
    symbol: KNOWN_TOKEN_ALIASES.get(address) || "UNKNOWN",
    name: "Unknown",
    decimals: null,
    error: "metadata_unavailable",
  };
}

async function fetchTokenMetadata(tokenAddresses) {
  const rows = await mapConcurrent(tokenAddresses, CONCURRENCY, async (address) => {
    const [symbolR, nameR, decimalsR] = await Promise.all([
      safe(async () => readErc20Symbol(address, { rpcUrl: DEFAULT_RPC_URL })),
      safe(async () => readErc20Name(address, { rpcUrl: DEFAULT_RPC_URL })),
      safe(async () => readErc20Decimals(address, { rpcUrl: DEFAULT_RPC_URL })),
    ]);
    const fallbackAlias = KNOWN_TOKEN_ALIASES.get(address);
    return {
      address,
      symbol: symbolR.ok ? symbolR.value : fallbackAlias || "UNKNOWN",
      name: nameR.ok ? nameR.value : fallbackAlias || "Unknown",
      decimals: decimalsR.ok ? decimalsR.value : null,
      error: [symbolR, nameR, decimalsR].filter((x) => !x.ok).map((x) => x.error).join("; ") || null,
    };
  });

  const map = new Map();
  for (const row of rows) map.set(row.address, row);
  return map;
}

function defaultPoolMeta() {
  return { tickSpacing: null, currentTick: null, error: "pool_metadata_unavailable" };
}

async function fetchPoolMetadata(poolAddresses) {
  const rows = await mapConcurrent(poolAddresses, CONCURRENCY, async (pool) => {
    const [tickSpacingR, stateR] = await Promise.all([
      safe(async () => readPoolTickSpacing(pool, { rpcUrl: DEFAULT_RPC_URL })),
      safe(async () => readPoolGlobalState(pool, { rpcUrl: DEFAULT_RPC_URL })),
    ]);
    return {
      pool,
      tickSpacing: tickSpacingR.ok ? tickSpacingR.value : null,
      currentTick: stateR.ok ? stateR.value.tick : null,
      error: [tickSpacingR, stateR].filter((x) => !x.ok).map((x) => x.error).join("; ") || null,
    };
  });

  const map = new Map();
  for (const row of rows) map.set(row.pool, row);
  return map;
}

function buildTokenRows(enrichedPools, tokenMetaMap) {
  const usage = new Map();
  for (const row of enrichedPools) {
    for (const token of [row.token0, row.token1]) {
      if (!usage.has(token)) {
        usage.set(token, { poolCount: 0, defaultPoolCount: 0, customPoolCount: 0 });
      }
      const bucket = usage.get(token);
      bucket.poolCount += 1;
      if (row.eventType === "CustomPool") bucket.customPoolCount += 1;
      else bucket.defaultPoolCount += 1;
    }
  }

  return [...usage.entries()]
    .map(([address, counts]) => {
      const meta = tokenMetaMap.get(address) || defaultTokenMeta(address);
      return {
        address,
        symbol: meta.symbol,
        name: meta.name,
        decimals: meta.decimals,
        poolCount: counts.poolCount,
        defaultPoolCount: counts.defaultPoolCount,
        customPoolCount: counts.customPoolCount,
      };
    })
    .sort((a, b) => {
      const symbolA = String(a.symbol || "");
      const symbolB = String(b.symbol || "");
      if (symbolA !== symbolB) return symbolA.localeCompare(symbolB);
      return a.address.localeCompare(b.address);
    });
}

function escapeCell(value) {
  return String(value == null ? "" : value).replace(/\|/g, "\\|");
}

function toExplorerAddress(address) {
  return `https://www.hyperscan.com/address/${address}`;
}

function toExplorerTx(txHash) {
  return `https://www.hyperscan.com/tx/${txHash}`;
}

function renderMarkdown(payload) {
  const lines = [];
  lines.push("# KittenSwap HyperEVM Token and Pair Inventory");
  lines.push("");
  lines.push(`Generated at: \`${payload.generatedAt}\``);
  lines.push("");
  lines.push("## Scope");
  lines.push("");
  lines.push(`- Chain ID: \`${payload.chainId}\``);
  lines.push(`- RPC: \`${payload.rpcUrl}\``);
  lines.push(`- Factory: \`${payload.coreContracts.factory}\``);
  lines.push(`- Source endpoint: \`${payload.source.factoryLogsEndpoint}\``);
  lines.push("");
  lines.push("## Core Contracts");
  lines.push("");
  lines.push(`- Factory: \`${payload.coreContracts.factory}\``);
  lines.push(`- QuoterV2: \`${payload.coreContracts.quoterV2}\``);
  lines.push(`- SwapRouter: \`${payload.coreContracts.router}\``);
  lines.push(`- NonfungiblePositionManager: \`${payload.coreContracts.positionManager}\``);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Latest RPC block: \`${payload.stats.latestBlock ?? "n/a"}\``);
  lines.push(`- Hyperscan pages read: \`${payload.stats.hyperscanPagesRead}\``);
  lines.push(`- Pool events read: \`${payload.stats.poolEventsRead}\``);
  lines.push(`- Unique pools: \`${payload.stats.uniquePools}\``);
  lines.push(`- Default pools: \`${payload.stats.defaultPools}\``);
  lines.push(`- Custom pools: \`${payload.stats.customPools}\``);
  lines.push(`- Unique tokens: \`${payload.stats.uniqueTokens}\``);
  lines.push("");
  lines.push("## Token CAs");
  lines.push("");
  lines.push("| Symbol | Name | Address | Decimals | Pool count |");
  lines.push("|---|---|---|---:|---:|");
  for (const token of payload.tokens) {
    lines.push(
      `| ${escapeCell(token.symbol)} | ${escapeCell(token.name)} | [\`${token.address}\`](${toExplorerAddress(token.address)}) | ${token.decimals ?? ""} | ${token.poolCount} |`
    );
  }
  lines.push("");
  lines.push("## Pair and Pool CAs");
  lines.push("");
  lines.push("| Token0 | Token1 | Pool | Type | Deployer | Block | Tick spacing | Current tick | Tx |");
  lines.push("|---|---|---|---|---|---:|---:|---:|---|");
  for (const row of payload.pairs) {
    lines.push(
      `| ${escapeCell(row.token0Symbol)} [\`${row.token0}\`](${toExplorerAddress(row.token0)}) | ${escapeCell(row.token1Symbol)} [\`${row.token1}\`](${toExplorerAddress(row.token1)}) | [\`${row.pool}\`](${toExplorerAddress(row.pool)}) | ${row.eventType} | [\`${row.deployer}\`](${toExplorerAddress(row.deployer)}) | ${row.blockNumber} | ${row.tickSpacing ?? ""} | ${row.currentTick ?? ""} | [tx](${toExplorerTx(row.txHash)}) |`
    );
  }
  lines.push("");
  lines.push("## Notes");
  lines.push("");
  lines.push("- `Pool` rows use the default deployer (`0x0000000000000000000000000000000000000000`).");
  lines.push("- `CustomPool` rows preserve the emitted deployer address from the factory event.");
  lines.push("- Token metadata is fetched live via ERC20 calls (`symbol`, `name`, `decimals`) and can change if token contracts are upgraded.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function writeOutputFiles(payload, jsonPath, markdownPath) {
  await mkdir(dirname(jsonPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderMarkdown(payload), "utf8");
}

async function safe(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

main().catch((error) => {
  console.error(`Inventory refresh failed: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exitCode = 1;
});
