#!/usr/bin/env node
/**
 * Repo-contained Kittenswap simulation suite.
 *
 * Scope:
 * - Pure logic/calldata checks
 * - Live HyperEVM connectivity + contract sanity
 * - Command-layer precision/safety checks
 *
 * Designed to run without external local archives.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");

const SKILL_SCRIPTS_DIR = path.join(
  ROOT,
  "skills",
  "auto-kittenswap-lp-rebalance",
  "scripts"
);
const CHAT_SCRIPT = path.join(SKILL_SCRIPTS_DIR, "kittenswap_rebalance_chat.mjs");
const REPORTS_DIR = path.join(ROOT, "internal-tests", "kittenswap", "reports");
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, "-");

const api = await import(pathToFileURL(path.join(SKILL_SCRIPTS_DIR, "kittenswap_rebalance_api.mjs")).href);

function isAddress(v) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(v ?? ""));
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCmd(args, { expectExit = 0, timeoutMs = 90_000, retries = 4, retryDelayMs = 1200 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, args, {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let done = false;

      const timer = setTimeout(() => {
        if (!done) child.kill("SIGKILL");
      }, timeoutMs);

      child.stdout.on("data", (d) => (stdout += String(d)));
      child.stderr.on("data", (d) => (stderr += String(d)));
      child.on("close", (code) => {
        clearTimeout(timer);
        done = true;
        resolve({
          code,
          expectExit,
          ok: code === expectExit,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
        });
      });
    });

    const merged = `${result.stdout}\n${result.stderr}`;
    const rateLimited = /rate limited|too many requests|\b429\b/i.test(merged);
    if (!rateLimited || attempt >= retries) return result;
    await sleep(retryDelayMs * 2 ** attempt);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertEq(a, b, msg) {
  if (a !== b) throw new Error(`${msg} (got=${a} expected=${b})`);
}

function assertRegex(text, re, msg) {
  if (!re.test(String(text ?? ""))) throw new Error(msg);
}

function assertNotRegex(text, re, msg) {
  if (re.test(String(text ?? ""))) throw new Error(msg);
}

const results = [];

async function test(name, fn) {
  const started = Date.now();
  try {
    const details = await fn();
    results.push({ name, pass: true, durationMs: Date.now() - started, details: details ?? null });
  } catch (err) {
    results.push({
      name,
      pass: false,
      durationMs: Date.now() - started,
      error: err?.message || String(err),
      stack: err?.stack || null,
    });
  }
}

function summary() {
  const total = results.length;
  const passed = results.filter((x) => x.pass).length;
  return { total, passed, failed: total - passed };
}

await test("logic: parse/format roundtrip", async () => {
  const raw = api.parseDecimalToUnits("1.234567", 18);
  assertEq(raw.toString(), "1234567000000000000", "parseDecimalToUnits mismatch");
  assertEq(api.formatUnits(raw, 18, { precision: 6 }), "1.234567", "formatUnits mismatch");
});

await test("calldata: approve/swap selectors", async () => {
  const approve = api.buildApproveCalldata({
    spender: "0x2222222222222222222222222222222222222222",
    amount: 1000n,
  });
  const swap = api.buildSwapExactInputSingleCalldata({
    tokenIn: "0x1111111111111111111111111111111111111111",
    tokenOut: "0x2222222222222222222222222222222222222222",
    deployer: "0x0000000000000000000000000000000000000000",
    recipient: "0x3333333333333333333333333333333333333333",
    deadline: 123n,
    amountIn: 100n,
    amountOutMinimum: 90n,
    limitSqrtPrice: 0n,
  });
  assert(approve.startsWith("0x095ea7b3"), "approve selector mismatch");
  assert(swap.startsWith("0x1679c792"), "swap selector mismatch");
  assertEq(approve.length, 2 + 8 + 64 * 2, "approve calldata length mismatch");
  assertEq(swap.length, 2 + 8 + 64 * 8, "swap calldata length mismatch");
});

await test("chain: HyperEVM id and block", async () => {
  const cid = await api.rpcChainId();
  const block = await api.rpcBlockNumber();
  assertEq(String(cid.decimal), "999", "unexpected chain id");
  assert(block.decimal > 0, "block must be > 0");
});

await test("chain: core contract bytecode non-empty", async () => {
  for (const [name, addr] of Object.entries(api.KITTENSWAP_CONTRACTS)) {
    const code = await api.rpcCall("eth_getCode", [addr, "latest"]);
    assert(/^0x[0-9a-fA-F]+$/.test(code), `invalid code hex for ${name}`);
    assert(code.length > 4, `empty code for ${name}`);
  }
});

await test("kittenswap: router WNativeToken expected", async () => {
  const w = await api.readRouterWNativeToken();
  assertEq(w, "0x5555555555555555555555555555555555555555", "unexpected WNativeToken");
});

await test("kittenswap: position #1 and quote sanity", async () => {
  const owner = await api.readOwnerOf(1n);
  const pos = await api.readPosition(1n);
  assert(isAddress(owner), "owner must be address");
  assert(isAddress(pos.token0), "token0 invalid");
  assert(isAddress(pos.token1), "token1 invalid");
  assert(pos.tickUpper > pos.tickLower, "ticks invalid");

  const q = await api.quoteExactInputSingle({
    tokenIn: pos.token0,
    tokenOut: pos.token1,
    deployer: pos.deployer,
    amountIn: api.parseDecimalToUnits("0.0005", 18),
    limitSqrtPrice: 0n,
  });
  assert(q.amountOut >= 0n, "quote amountOut invalid");
});

await test("kittenswap: wallet token enumeration contains known token", async () => {
  const owner = await api.readOwnerOf(1n);
  const tokenIds = await api.listOwnedTokenIds(owner, { positionManager: api.KITTENSWAP_CONTRACTS.positionManager });
  assert(tokenIds.length > 0, "owner should have at least one token");
  assert(tokenIds.some((x) => x === 1n), "owner token list must include token id 1");
});

await test("kittenswap: collect simulation returns uints", async () => {
  const owner = await api.readOwnerOf(1n);
  const out = await api.simulateCollect({
    tokenId: 1n,
    recipient: owner,
    fromAddress: owner,
    positionManager: api.KITTENSWAP_CONTRACTS.positionManager,
  });
  assert(typeof out.amount0 === "bigint" && out.amount0 >= 0n, "collect amount0 invalid");
  assert(typeof out.amount1 === "bigint" && out.amount1 >= 0n, "collect amount1 invalid");
});

await test("kittenswap: decreaseLiquidity simulation handles active/inactive", async () => {
  const owner = await api.readOwnerOf(1n);
  const pos = await api.readPosition(1n, { positionManager: api.KITTENSWAP_CONTRACTS.positionManager });
  if (pos.liquidity === 0n) {
    return { skipped: true, reason: "token 1 liquidity is zero" };
  }
  const latestBlock = await api.rpcGetBlockByNumber("latest", false);
  const nowTs = latestBlock?.timestamp ? Number(BigInt(latestBlock.timestamp)) : Math.floor(Date.now() / 1000);
  const out = await api.simulateDecreaseLiquidity({
    tokenId: 1n,
    liquidity: pos.liquidity,
    amount0Min: 0n,
    amount1Min: 0n,
    deadline: BigInt(nowTs + 900),
    fromAddress: owner,
    positionManager: api.KITTENSWAP_CONTRACTS.positionManager,
  });
  assert(typeof out.amount0 === "bigint" && out.amount0 >= 0n, "decrease amount0 invalid");
  assert(typeof out.amount1 === "bigint" && out.amount1 >= 0n, "decrease amount1 invalid");
});

await test("chat: health deterministic basics", async () => {
  const run = await runCmd([CHAT_SCRIPT, "krlp health"], { expectExit: 0 });
  assert(run.ok, `health failed: ${run.stderr}`);
  assertRegex(run.stdout, /expected chain id:\s*999/i, "health missing chain id");
  assertRegex(run.stdout, /rpc url:\s*https:\/\/rpc\.hyperliquid\.xyz\/evm/i, "health missing rpc url");
});

await test("chat: contracts output full addresses", async () => {
  const run = await runCmd([CHAT_SCRIPT, "krlp contracts"], { expectExit: 0 });
  assert(run.ok, `contracts failed: ${run.stderr}`);
  assertNotRegex(run.stdout, /0x[0-9a-fA-F]{4,}\.\.\.[0-9a-fA-F]{2,}/, "truncated address found");
  const addrs = run.stdout.match(/0x[0-9a-fA-F]{40}/g) || [];
  assert(addrs.length >= 4, "missing full addresses");
});

await test("chat: status reports decision/range", async () => {
  const run = await runCmd([CHAT_SCRIPT, "krlp status 1"], { expectExit: 0 });
  assert(run.ok, `status failed: ${run.stderr}`);
  assertRegex(run.stdout, /rebalance:\s*(YES|NO)/i, "rebalance decision missing");
  assertRegex(run.stdout, /suggested new range:/i, "suggested range missing");
});

await test("chat: value command outputs simulation methodology", async () => {
  const run = await runCmd([CHAT_SCRIPT, "krlp value 1"], { expectExit: 0, timeoutMs: 120_000 });
  assert(run.ok, `value failed: ${run.stderr}`);
  assertRegex(run.stdout, /method \(principal\): eth_call decreaseLiquidity/i, "principal method missing");
  assertRegex(run.stdout, /method \(rewards\): eth_call collect/i, "rewards method missing");
  assertRegex(run.stdout, /principal if burn now \(simulated\):/i, "principal simulation line missing");
  assertNotRegex(run.stdout, /0x[0-9a-fA-F]{4,}\.\.\.[0-9a-fA-F]{2,}/, "truncated address found in value output");
});

await test("chat: wallet command outputs aggregate rewards", async () => {
  const owner = await api.readOwnerOf(1n);
  const run = await runCmd([CHAT_SCRIPT, `krlp wallet ${owner} --active-only`], { expectExit: 0, timeoutMs: 180_000 });
  assert(run.ok, `wallet failed: ${run.stderr}`);
  assertRegex(run.stdout, /total position NFTs:/i, "wallet total count missing");
  assertRegex(run.stdout, /aggregate claimable rewards/i, "wallet rewards summary missing");
  assertRegex(run.stdout, /methodology:/i, "wallet methodology missing");
  assertNotRegex(run.stdout, /0x[0-9a-fA-F]{4,}\.\.\.[0-9a-fA-F]{2,}/, "truncated address found in wallet output");
});

await test("chat: swap-quote alias", async () => {
  const run = await runCmd(
    [CHAT_SCRIPT, "krlp swap-quote 0x5555555555555555555555555555555555555555 0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb --deployer 0x0000000000000000000000000000000000000000 --amount-in 0.001"],
    { expectExit: 0 }
  );
  assert(run.ok, `swap-quote failed: ${run.stderr}`);
  assertRegex(run.stdout, /quoteExactInputSingle/i, "quote header missing");
  assertRegex(run.stdout, /quoted amount out:/i, "quoted amount missing");
});

await test("chat: swap-approve-plan outputs approve calldata", async () => {
  const owner = await api.readOwnerOf(1n);
  const cmd = `krlp swap-approve-plan 0x5555555555555555555555555555555555555555 ${owner} --amount 0.001`;
  const run = await runCmd([CHAT_SCRIPT, cmd], { expectExit: 0 });
  assert(run.ok, `swap-approve-plan failed: ${run.stderr}`);
  assertRegex(run.stdout, /0x095ea7b3[0-9a-fA-F]+/i, "approve calldata missing");
});

await test("chat: swap-plan includes routing + calldata", async () => {
  const owner = await api.readOwnerOf(1n);
  const cmd = `krlp swap-plan 0x5555555555555555555555555555555555555555 0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb --deployer 0x0000000000000000000000000000000000000000 --amount-in 0.001 ${owner} --recipient ${owner} --slippage-bps 75`;
  const run = await runCmd([CHAT_SCRIPT, cmd], { expectExit: 0, timeoutMs: 120_000 });
  assert(run.ok, `swap-plan failed: ${run.stderr}`);
  assertRegex(run.stdout, /routing:\s*single-hop/i, "routing mode missing");
  assertRegex(run.stdout, /data:\s*0x1679c792/i, "swap calldata missing");
  assertRegex(run.stdout, /minimum amount out:/i, "min-out missing");
});

await test("chat: swap-plan rejects identical token pair", async () => {
  const run = await runCmd(
    [CHAT_SCRIPT, "krlp swap-plan 0x5555555555555555555555555555555555555555 0x5555555555555555555555555555555555555555 --deployer 0x0000000000000000000000000000000000000000 --amount-in 0.001"],
    { expectExit: 1 }
  );
  assert(run.ok, `same token validation expected exit=1, got ${run.code}`);
  assertRegex(`${run.stdout}\n${run.stderr}`, /must differ/i, "same-token message missing");
});

await test("chat: native-in validation", async () => {
  const owner = await api.readOwnerOf(1n);
  const run = await runCmd(
    [CHAT_SCRIPT, `krlp swap-plan 0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb 0x5555555555555555555555555555555555555555 --deployer 0x0000000000000000000000000000000000000000 --amount-in 1 ${owner} --native-in`],
    { expectExit: 1, timeoutMs: 120_000 }
  );
  assert(run.ok, `native-in validation expected exit=1, got ${run.code}`);
  assertRegex(`${run.stdout}\n${run.stderr}`, /requires tokenIn == router WNativeToken/i, "native-in validation message missing");
});

await test("chat: swap-broadcast confirmation gate", async () => {
  const run = await runCmd([CHAT_SCRIPT, "krlp swap-broadcast 0x1234"], { expectExit: 1 });
  assert(run.ok, `swap-broadcast expected exit=1, got ${run.code}`);
  assertRegex(`${run.stdout}\n${run.stderr}`, /Broadcast blocked/i, "broadcast gate message missing");
});

await test("chat: precision sweep across slippage/amounts", async () => {
  const owner = await api.readOwnerOf(1n);
  const cases = [
    { amountIn: "0.0003", slippage: 10 },
    { amountIn: "0.0007", slippage: 35 },
    { amountIn: "0.0011", slippage: 75 },
    { amountIn: "0.0019", slippage: 120 },
  ];
  for (const c of cases) {
    const cmd = `krlp swap-plan 0x5555555555555555555555555555555555555555 0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb --deployer 0x0000000000000000000000000000000000000000 --amount-in ${c.amountIn} ${owner} --recipient ${owner} --slippage-bps ${c.slippage}`;
    const run = await runCmd([CHAT_SCRIPT, cmd], { expectExit: 0, timeoutMs: 120_000 });
    assert(run.ok, `sweep case failed (${c.amountIn}, ${c.slippage}): ${run.stderr}`);
    assertRegex(run.stdout, /minimum amount out:/i, "min-out missing");
    assertNotRegex(run.stdout, /0x[0-9a-fA-F]{4,}\.\.\.[0-9a-fA-F]{2,}/, "truncated address in sweep case");
    await sleep(250);
  }
});

const sum = summary();
const report = {
  meta: {
    generatedAt: nowIso(),
    suite: "kittenswap_repo_sim_suite",
    root: ROOT,
  },
  summary: sum,
  results,
};

await fs.mkdir(REPORTS_DIR, { recursive: true });
const reportJson = path.join(REPORTS_DIR, `sim-${TIMESTAMP}.json`);
const reportMd = path.join(REPORTS_DIR, `sim-${TIMESTAMP}.md`);
const latestJson = path.join(REPORTS_DIR, "latest-sim.json");
const latestMd = path.join(REPORTS_DIR, "latest-sim.md");

await fs.writeFile(reportJson, JSON.stringify(report, null, 2) + "\n", "utf8");
await fs.writeFile(latestJson, JSON.stringify(report, null, 2) + "\n", "utf8");

const lines = [];
lines.push("# Kittenswap Repo Sim Suite");
lines.push("");
lines.push(`- Generated: ${report.meta.generatedAt}`);
lines.push(`- Total: ${sum.total}`);
lines.push(`- Passed: ${sum.passed}`);
lines.push(`- Failed: ${sum.failed}`);
lines.push("");
lines.push("## Results");
for (const r of results) {
  lines.push(`- ${r.pass ? "PASS" : "FAIL"} \`${r.name}\` (${r.durationMs} ms)`);
  if (!r.pass) lines.push(`  - Error: ${r.error}`);
}
lines.push("");
lines.push("## Safety Assertions");
lines.push("- No address truncation in key command outputs.");
lines.push("- Broadcast commands require explicit confirmation.");
lines.push("- Swap plan outputs full calldata and explicit routing mode.");

const md = lines.join("\n") + "\n";
await fs.writeFile(reportMd, md, "utf8");
await fs.writeFile(latestMd, md, "utf8");

console.log(`Report JSON: ${reportJson}`);
console.log(`Report MD:   ${reportMd}`);
console.log(`Summary: ${sum.passed}/${sum.total} passed`);

if (sum.failed > 0) process.exit(1);
