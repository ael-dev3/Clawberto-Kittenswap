#!/usr/bin/env node
// Command + NL interface for Kittenswap LP rebalance planning on HyperEVM.

import {
  DEFAULT_CHAIN_ID,
  DEFAULT_RPC_URL,
  KITTENSWAP_CONTRACTS,
  normalizeAddress,
  assertAddress,
  txLink,
  addressLink,
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
  quoteExactInputSingle,
  parseTokenId,
  parseDecimalToUnits,
  formatUnits,
  parseBps,
  parseSeconds,
  evaluateRebalanceNeed,
  suggestCenteredRange,
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

function parseOptionalUint(input, fallback = 0n) {
  if (input == null || String(input).trim() === "") return fallback;
  const s = String(input).trim();
  const n = s.startsWith("0x") || s.startsWith("0X") ? BigInt(s) : BigInt(s.replace(/_/g, ""));
  if (n < 0n) throw new Error(`Expected non-negative integer, got: ${input}`);
  return n;
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
    readOwnerOf(tokenId, { positionManager: KITTENSWAP_CONTRACTS.positionManager }),
    readPosition(tokenId, { positionManager: KITTENSWAP_CONTRACTS.positionManager }),
  ]);

  const poolAddress = await readPoolAddressByPair(pos.token0, pos.token1, { factory: KITTENSWAP_CONTRACTS.factory });
  if (!poolAddress) {
    throw new Error(`No pool found for pair ${pos.token0} / ${pos.token1}`);
  }

  const [poolState, tickSpacing, token0, token1] = await Promise.all([
    readPoolGlobalState(poolAddress),
    readPoolTickSpacing(poolAddress),
    readTokenSnapshot(pos.token0, ownerAddress),
    readTokenSnapshot(pos.token1, ownerAddress),
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

async function cmdQuoteSwap({ tokenInRef, tokenOutRef, deployerRef, amountInDecimal }) {
  const tokenIn = assertAddress(tokenInRef);
  const tokenOut = assertAddress(tokenOutRef);
  const deployer = assertAddress(deployerRef);

  const [inMeta, outMeta] = await Promise.all([
    readTokenSnapshot(tokenIn),
    readTokenSnapshot(tokenOut),
  ]);

  const amountIn = parseDecimalToUnits(amountInDecimal, inMeta.decimals);
  if (amountIn <= 0n) throw new Error("amount-in must be > 0");

  const q = await quoteExactInputSingle({
    tokenIn,
    tokenOut,
    deployer,
    amountIn,
    limitSqrtPrice: 0n,
  });

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

  const tokenMeta = await readTokenSnapshot(token, owner);
  const currentAllowance = await readErc20Allowance(token, owner, spender).catch(() => null);

  const useMax = parseBoolFlag(approveMax) || String(amountRef || "").toLowerCase() === "max";
  const approveAmount = useMax ? maxUint256() : parseDecimalToUnits(String(amountRef), tokenMeta.decimals);
  if (approveAmount <= 0n) throw new Error("approve amount must be > 0");

  const data = buildApproveCalldata({ spender, amount: approveAmount });
  const gas = await estimateCallGas({ from: owner, to: token, data, value: 0n });
  const gasPriceHex = await rpcGasPrice().catch(() => null);
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
    readTokenSnapshot(tokenIn, owner),
    readTokenSnapshot(tokenOut, owner),
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

  const quote = await quoteExactInputSingle({
    tokenIn,
    tokenOut,
    deployer,
    amountIn,
    limitSqrtPrice,
  });
  const amountOutMin = (quote.amountOut * BigInt(10_000 - effSlipBps)) / 10_000n;

  const latestBlock = await rpcGetBlockByNumber("latest", false).catch(() => null);
  const nowTs = latestBlock?.timestamp ? Number(BigInt(latestBlock.timestamp)) : Math.floor(Date.now() / 1000);
  const deadline = BigInt(nowTs + effDeadlineSec);

  const allowanceCheck = useNativeIn
    ? null
    : await readErc20Allowance(tokenIn, owner, KITTENSWAP_CONTRACTS.router)
      .then((value) => ({ ok: true, value, error: null }))
      .catch((e) => ({ ok: false, value: null, error: e?.message || String(e) }));
  const allowance = allowanceCheck?.value ?? null;
  const needsApproval = !useNativeIn && (!allowanceCheck?.ok || allowance < amountIn);
  const approveAmount = parseBoolFlag(approveMax) ? maxUint256() : amountIn;

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

  const [poolAddress, gasPriceHex, gasEstimates] = await Promise.all([
    readPoolAddressByPair(tokenIn, tokenOut, { factory: KITTENSWAP_CONTRACTS.factory }).catch(() => null),
    rpcGasPrice().catch(() => null),
    Promise.all(calls.map((c) => estimateCallGas({ from: owner, to: c.to, data: c.data, value: c.value }))),
  ]);

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
  lines.push(`- wallet balances: ${tokenInMeta.balance == null ? "n/a" : `${formatUnits(tokenInMeta.balance, tokenInMeta.decimals, { precision: 8 })} ${tokenInMeta.symbol}`} | ${tokenOutMeta.balance == null ? "n/a" : `${formatUnits(tokenOutMeta.balance, tokenOutMeta.decimals, { precision: 8 })} ${tokenOutMeta.symbol}`}`);
  if (useNativeIn) {
    lines.push(`- native input mode: enabled (msg.value = ${formatUnits(swapValue, 18, { precision: 8 })} HYPE)`);
  } else {
    lines.push(`- router allowance (${tokenInMeta.symbol}): ${allowance == null ? "n/a" : formatUnits(allowance, tokenInMeta.decimals, { precision: 8 })}`);
    if (!allowanceCheck?.ok) {
      lines.push(`- allowance read: unavailable (${allowanceCheck.error})`);
    }
    lines.push(`- approval required: ${needsApproval ? "YES" : "NO"}`);
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

  if (amount0Decimal != null && amount1Decimal != null) {
    amount0DesiredRaw = parseDecimalToUnits(String(amount0Decimal), ctx.token0.decimals);
    amount1DesiredRaw = parseDecimalToUnits(String(amount1Decimal), ctx.token1.decimals);
    if (amount0DesiredRaw <= 0n || amount1DesiredRaw <= 0n) {
      throw new Error("amount0 and amount1 must be > 0 for mint calldata.");
    }
    mintData = buildMintCalldata({
      token0: ctx.position.token0,
      token1: ctx.position.token1,
      deployer: ctx.position.deployer,
      tickLower: rec.tickLower,
      tickUpper: rec.tickUpper,
      amount0Desired: amount0DesiredRaw,
      amount1Desired: amount1DesiredRaw,
      amount0Min: (amount0DesiredRaw * BigInt(10_000 - effSlipBps)) / 10_000n,
      amount1Min: (amount1DesiredRaw * BigInt(10_000 - effSlipBps)) / 10_000n,
      recipient,
      deadline,
    });
  }

  const calls = [
    { step: "collect_before", to: KITTENSWAP_CONTRACTS.positionManager, data: collectBeforeData, value: 0n },
    { step: "decrease_liquidity", to: KITTENSWAP_CONTRACTS.positionManager, data: decreaseData, value: 0n },
    { step: "collect_after", to: KITTENSWAP_CONTRACTS.positionManager, data: collectAfterData, value: 0n },
    { step: "burn_old_nft", to: KITTENSWAP_CONTRACTS.positionManager, data: burnData, value: 0n },
  ];
  if (mintData) calls.push({ step: "mint_new_position", to: KITTENSWAP_CONTRACTS.positionManager, data: mintData, value: 0n });

  const [gasPriceHex, gasEstimates] = await Promise.all([
    rpcGasPrice().catch(() => null),
    Promise.all(calls.map((c) => estimateCallGas({ from: owner, to: c.to, data: c.data, value: c.value }))),
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
  lines.push(`- decision: ${evald.shouldRebalance ? "REBALANCE" : "NO_REBALANCE"} (${evald.reason})`);
  lines.push(`- policy: ${policyLoaded.key} (edge=${effEdgeBps}bps, slippage=${effSlipBps}bps, deadline=${effDeadlineSec}s)`);
  lines.push(`- deadline unix: ${deadline.toString()}`);
  lines.push(`- wallet balances: ${formatUnits(ctx.token0.balance, ctx.token0.decimals, { precision: 8 })} ${ctx.token0.symbol} | ${formatUnits(ctx.token1.balance, ctx.token1.decimals, { precision: 8 })} ${ctx.token1.symbol}`);

  if (balanceHint) {
    lines.push(`- balance hint: ${balanceHint.explanation}`);
  }

  if (!mintData) {
    lines.push("- mint calldata: not generated (provide both --amount0 and --amount1 to include final mint step)");
  } else {
    lines.push(`- mint desired: ${formatUnits(amount0DesiredRaw, ctx.token0.decimals, { precision: 8 })} ${ctx.token0.symbol} + ${formatUnits(amount1DesiredRaw, ctx.token1.decimals, { precision: 8 })} ${ctx.token1.symbol}`);
  }

  lines.push("- transaction templates (full calldata):");
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i];
    const g = gasEstimates[i];
    lines.push(`  - step ${i + 1}: ${c.step}`);
    lines.push(`    - to: ${c.to}`);
    lines.push(`    - value: ${toHexQuantity(c.value)} (0 HYPE)`);
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
    "  status <tokenId> [--edge-bps N]",
    "  quote-swap|swap-quote <tokenIn> <tokenOut> --deployer <address> --amount-in <decimal>",
    "  swap-approve-plan <token> [owner|label] --amount <decimal|max> [--spender <address>] [--approve-max]",
    "  swap-plan <tokenIn> <tokenOut> --deployer <address> --amount-in <decimal> [owner|label] [--recipient <address|label>] [--policy <name>] [--slippage-bps N] [--deadline-seconds N] [--native-in] [--approve-max]",
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
  if (t.includes("health") || t.includes("rpc") || t.includes("chain")) return { cmd: "health" };
  if (t.includes("contracts")) return { cmd: "contracts" };
  if (t.includes("swap") && t.includes("quote")) return { cmd: "swap-quote" };
  if (t.includes("policy")) return { cmd: "policy show" };
  if (t.includes("swap") && t.includes("approve")) return { cmd: "swap-approve-plan" };
  if (t.includes("swap")) return { cmd: "swap-plan" };
  if (t.includes("status") && /\b\d+\b/.test(t)) return { cmd: "status" };
  if ((t.includes("rebalance") || t.includes("plan")) && /\b\d+\b/.test(t)) return { cmd: "plan" };
  if (t.includes("position") && /\b\d+\b/.test(t)) return { cmd: "position" };
  return { cmd: "help" };
}

function firstInteger(text) {
  const m = String(text ?? "").match(/\b\d+\b/);
  return m ? m[0] : "";
}

async function runNL(raw) {
  const guess = guessIntentFromNL(raw);
  if (guess.cmd === "health") return cmdHealth();
  if (guess.cmd === "contracts") return cmdContracts();
  if (guess.cmd === "swap-quote") return usage();
  if (guess.cmd === "policy show") return cmdPolicy({ _: ["policy", "show"] });
  if (guess.cmd === "swap-approve-plan") return usage();
  if (guess.cmd === "swap-plan") return usage();
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
