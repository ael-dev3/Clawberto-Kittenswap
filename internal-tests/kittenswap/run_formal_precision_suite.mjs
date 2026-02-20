#!/usr/bin/env node
/**
 * Formal precision gate for repo-contained Kittenswap simulations.
 *
 * Runs the repo sim suite multiple times and computes a precision score.
 * Gate target: 10/10 with all runs green.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");

const CORE_SUITE = path.join(ROOT, "internal-tests", "kittenswap", "run_sim_suite.mjs");
const REPORTS_DIR = path.join(ROOT, "internal-tests", "kittenswap", "reports", "formal");

function parseArgs(argv) {
  const out = { runs: 3, timeoutMs: 180_000 };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    const next = argv[i + 1];
    if (tok === "--runs" && next) {
      out.runs = Math.max(1, Math.min(20, Number(next)));
      i++;
      continue;
    }
    if (tok === "--timeout-ms" && next) {
      out.timeoutMs = Math.max(30_000, Math.min(600_000, Number(next)));
      i++;
      continue;
    }
  }
  if (!Number.isFinite(out.runs)) out.runs = 3;
  if (!Number.isFinite(out.timeoutMs)) out.timeoutMs = 180_000;
  return out;
}

function nowTag() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function runSuite(timeoutMs) {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [CORE_SUITE], {
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
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runSuiteWithRateLimitRetry(timeoutMs, { retries = 2, delayMs = 2000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const out = await runSuite(timeoutMs);
    const merged = `${out.stdout}\n${out.stderr}`;
    const rateLimited = /rate limited|too many requests|\b429\b/i.test(merged);
    if (!rateLimited || attempt >= retries) return out;
    await sleep(delayMs * 2 ** attempt);
  }
}

function parseReportPath(stdout) {
  const m = String(stdout).match(/Report JSON:\s*(.+)$/m);
  return m ? m[1].trim() : null;
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();

  const runs = [];
  for (let i = 0; i < args.runs; i++) {
    const r = await runSuiteWithRateLimitRetry(args.timeoutMs);
    const reportPath = parseReportPath(r.stdout);
    let summary = null;
    if (reportPath) {
      try {
        const parsed = JSON.parse(await fs.readFile(reportPath, "utf8"));
        summary = parsed?.summary || null;
      } catch {
        summary = null;
      }
    }
    runs.push({
      run: i + 1,
      code: r.code,
      reportPath,
      summary,
      stdout: r.stdout,
      stderr: r.stderr,
    });
  }

  let observedTotal = 0;
  let observedPassed = 0;
  let passRuns = 0;
  for (const r of runs) {
    if (r.summary) {
      observedTotal += Number(r.summary.total || 0);
      observedPassed += Number(r.summary.passed || 0);
    }
    if (r.code === 0 && r.summary && Number(r.summary.failed || 0) === 0) passRuns++;
  }

  const coveragePct = observedTotal > 0 ? (observedPassed / observedTotal) * 100 : 0;
  const stabilityPct = runs.length > 0 ? (passRuns / runs.length) * 100 : 0;
  const score = clamp((coveragePct * 0.7 + stabilityPct * 0.3) / 10, 0, 10);
  const precisionScore = Math.round(score * 100) / 100;
  const gatePass = precisionScore === 10 && passRuns === runs.length;

  const out = {
    meta: {
      suite: "kittenswap_formal_precision_gate",
      startedAt,
      finishedAt: new Date().toISOString(),
      runsRequested: args.runs,
      timeoutMs: args.timeoutMs,
      coreSuite: path.relative(ROOT, CORE_SUITE),
    },
    metrics: {
      passRuns,
      totalRuns: runs.length,
      coveragePct,
      stabilityPct,
      precisionScore,
      gatePass,
    },
    runs,
  };

  await fs.mkdir(REPORTS_DIR, { recursive: true });
  const tag = nowTag();
  const jsonPath = path.join(REPORTS_DIR, `formal-${tag}.json`);
  const mdPath = path.join(REPORTS_DIR, `formal-${tag}.md`);
  const latestJson = path.join(REPORTS_DIR, "latest.json");
  const latestMd = path.join(REPORTS_DIR, "latest.md");

  await fs.writeFile(jsonPath, JSON.stringify(out, null, 2) + "\n", "utf8");
  await fs.writeFile(latestJson, JSON.stringify(out, null, 2) + "\n", "utf8");

  const lines = [];
  lines.push("# Kittenswap Formal Precision Gate");
  lines.push("");
  lines.push(`- Runs: ${runs.length}`);
  lines.push(`- Pass runs: ${passRuns}/${runs.length}`);
  lines.push(`- Coverage: ${coveragePct.toFixed(2)}%`);
  lines.push(`- Stability: ${stabilityPct.toFixed(2)}%`);
  lines.push(`- Precision score: ${precisionScore}/10`);
  lines.push(`- Gate: ${gatePass ? "PASS" : "FAIL"}`);
  lines.push("");
  lines.push("## Per-run");
  for (const r of runs) {
    lines.push(`- Run ${r.run}: code=${r.code}, summary=${r.summary ? `${r.summary.passed}/${r.summary.total}` : "n/a"}, report=${r.reportPath || "n/a"}`);
  }
  lines.push("");
  const md = lines.join("\n") + "\n";
  await fs.writeFile(mdPath, md, "utf8");
  await fs.writeFile(latestMd, md, "utf8");

  console.log(`Formal JSON: ${jsonPath}`);
  console.log(`Formal MD:   ${mdPath}`);
  console.log(`Precision score: ${precisionScore}/10`);
  console.log(`Gate: ${gatePass ? "PASS" : "FAIL"}`);

  if (!gatePass) process.exit(1);
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
