#!/usr/bin/env node
// Resolve the current active tokenId for an owner and run heartbeat plan on it.
// Default output is a concise operator-grade summary to keep cron relays clean.

import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const rawArgs = process.argv.slice(2);
const isFlag = (value) => String(value || "").startsWith("--");

const scriptPath = fileURLToPath(new URL("./kittenswap_rebalance_chat.mjs", import.meta.url));

let ownerRef = "";
let recipientRef = "";
let outputMode = "summary"; // summary | raw
const heartbeatArgs = [];

const normalizedArgs = [...rawArgs];
if (normalizedArgs.length > 0 && !isFlag(normalizedArgs[0])) {
  ownerRef = normalizedArgs.shift();
}

for (let i = 0; i < normalizedArgs.length; i++) {
  const arg = normalizedArgs[i];
  if (arg === "--recipient") {
    recipientRef = normalizedArgs[i + 1] || recipientRef;
    i += 1;
    continue;
  }
  if (arg === "--raw") {
    outputMode = "raw";
    continue;
  }
  if (arg === "--summary") {
    outputMode = "summary";
    continue;
  }
  heartbeatArgs.push(arg);
}

function sleepMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, Math.floor(ms));
}

function execChat(input) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const run = spawnSync("node", [scriptPath, input], {
      encoding: "utf8",
      maxBuffer: 12_000_000,
      timeout: 180000,
    });
    if (run.error) throw run.error;
    if (run.status === 0) return run.stdout;

    const stderr = run.stderr || "";
    const stdout = run.stdout || "";
    const combined = `${stderr}\n${stdout}`;
    const isRateLimited = /rate\s*limit|rate\s*limited|\b429\b/i.test(combined);
    if (isRateLimited && attempt < maxAttempts) {
      sleepMs(500 * attempt);
      continue;
    }
    throw new Error(stderr || stdout || `chat command failed: ${run.status}`);
  }
  throw new Error("chat command failed after retries");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractLineValue(text, label) {
  const re = new RegExp(`^- ${escapeRegExp(label)}: (.+)$`, "m");
  const match = text.match(re);
  return match ? match[1].trim() : null;
}

function extractLineValueByPrefix(text, labelPrefix) {
  const re = new RegExp(`^- ${escapeRegExp(labelPrefix)}[^:]*: (.+)$`, "m");
  const match = text.match(re);
  return match ? match[1].trim() : null;
}

function parseTickWindow(lineValue) {
  if (!lineValue) return null;
  const m = String(lineValue).match(/\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]\s*\|\s*current\s*(-?\d+)/i);
  if (!m) return null;
  const lower = Number(m[1]);
  const upper = Number(m[2]);
  const current = Number(m[3]);
  if (![lower, upper, current].every(Number.isFinite)) return null;
  return { lower, upper, current };
}

function parseLowerUpperPair(lineValue) {
  if (!lineValue) return null;
  const m = String(lineValue).match(/lower\s*=?\s*(-?\d+)\s*\|\s*upper\s*=?\s*(-?\d+)/i);
  if (!m) return null;
  const lower = Number(m[1]);
  const upper = Number(m[2]);
  if (![lower, upper].every(Number.isFinite)) return null;
  return { lower, upper };
}

function buildHeartbeatSummary({ tokenId, ownerRef, recipientRef, heartbeatOutput }) {
  const get = (label) => extractLineValue(heartbeatOutput, label);

  const ownerSender = get("owner/sender") || ownerRef || "<default-account-resolved>";
  const recipient = get("recipient") || recipientRef || ownerSender;

  const decision = get("decision") || "n/a";
  const rebalanceEvaluation = get("rebalance evaluation") || "n/a";
  const requiredAction = get("required heartbeat action") || "n/a";

  const ticks = get("ticks") || "n/a";
  const withinRange = get("within range") || "n/a";
  const rangeEachSide = get("range each side") || "n/a";

  const tickWindow = parseTickWindow(ticks);
  const explicitRangeTicksEachSide = get("range ticks each side now");
  const explicitConfiguredTicksEachSide = get("configured ticks each side (half-width)");

  const derivedRangeTicksEachSide = tickWindow
    ? `lower=${tickWindow.current - tickWindow.lower} | upper=${tickWindow.upper - tickWindow.current}`
    : null;
  const widthTicks = tickWindow ? (tickWindow.upper - tickWindow.lower) : null;
  const derivedConfiguredTicksEachSide = Number.isFinite(widthTicks)
    ? `lower=${Math.floor(widthTicks / 2)} | upper=${widthTicks - Math.floor(widthTicks / 2)}`
    : null;

  const rangeTicksEachSide = explicitRangeTicksEachSide || derivedRangeTicksEachSide || "n/a";
  const configuredTicksEachSide = explicitConfiguredTicksEachSide || derivedConfiguredTicksEachSide || "n/a";

  const rangeTickPair = parseLowerUpperPair(rangeTicksEachSide);
  const configuredTickPair = parseLowerUpperPair(configuredTicksEachSide);
  const tickSideStatus = (rangeTickPair && configuredTickPair)
    ? `now lower ${rangeTickPair.lower} | upper ${rangeTickPair.upper}; target lower ${configuredTickPair.lower} | upper ${configuredTickPair.upper}`
    : null;

  const minHeadroom = get("min headroom pct") || "n/a";
  const threshold = get("heartbeat edge threshold") || "n/a";

  const stakeStatusCode = get("canonical stake status code") || "n/a";
  const stakedInFarm = get("staked in configured Kittenswap farm") || "n/a";
  const stakeIntegrity = get("stake integrity") || "n/a";

  const pendingRewardNow = get("pending reward now") || "n/a";
  const pendingRewardDelta = get("pending reward delta since last heartbeat") || "n/a";
  const realizedApr = get("est apr (realized from pending delta)") || "n/a";
  const rewardMarkPrice = extractLineValueByPrefix(heartbeatOutput, "reward mark price") || "n/a";
  const lpPrincipalMark = extractLineValueByPrefix(heartbeatOutput, "lp principal mark") || "n/a";
  const pendingBonusNow = get("pending bonus now");
  const heartbeatMode = get("heartbeat mode") || "n/a";
  const branch = get("branch") || decision;

  const triggerRangeEachSide = get("trigger position range each side");
  const triggerTicksEachSide = get("trigger position ticks each side");
  const triggerMinHeadroom = get("trigger position min headroom");
  const suggestedReplacementRange = get("suggested replacement range");
  const targetReplacementWidth = get("target replacement width");
  const stakeRemediation = get("stake remediation required");

  const lines = [];
  lines.push(`Kittenswap heartbeat summary (${tokenId})`);
  if (ownerSender === recipient) {
    lines.push(`- owner/recipient: ${ownerSender}`);
  } else {
    lines.push(`- owner/sender: ${ownerSender}`);
    lines.push(`- recipient: ${recipient}`);
  }
  lines.push(`- decision: ${decision} | rebalance: ${rebalanceEvaluation} | action: ${requiredAction}`);
  lines.push(`- range: ${ticks} | in-range ${withinRange}`);
  lines.push(`- range each side: ${rangeEachSide}`);
  lines.push(`- ticks each side now: ${rangeTicksEachSide}`);
  lines.push(`- configured ticks each side: ${configuredTicksEachSide}`);
  if (tickSideStatus) lines.push(`- tick side status: ${tickSideStatus}`);
  lines.push(`- min headroom: ${minHeadroom} (threshold ${threshold})`);
  lines.push(`- stake: ${stakeStatusCode} | configured farm ${stakedInFarm} | integrity ${stakeIntegrity}`);
  lines.push(`- pending reward now: ${pendingRewardNow}`);
  lines.push(`- pending reward delta: ${pendingRewardDelta}`);
  lines.push(`- reward mark price: ${rewardMarkPrice}`);
  lines.push(`- lp principal mark: ${lpPrincipalMark}`);
  lines.push(`- est apr: ${realizedApr}`);
  if (pendingBonusNow) lines.push(`- pending bonus now: ${pendingBonusNow}`);
  lines.push(`- mode/branch: ${heartbeatMode} / ${branch}`);

  if (triggerRangeEachSide || triggerTicksEachSide || triggerMinHeadroom || suggestedReplacementRange || targetReplacementWidth) {
    lines.push("- trigger context:");
    if (triggerRangeEachSide) lines.push(`  - range each side: ${triggerRangeEachSide}`);
    if (triggerTicksEachSide) lines.push(`  - ticks each side: ${triggerTicksEachSide}`);
    if (triggerMinHeadroom) lines.push(`  - min headroom: ${triggerMinHeadroom}`);
    if (suggestedReplacementRange) lines.push(`  - suggested replacement range: ${suggestedReplacementRange}`);
    if (targetReplacementWidth) lines.push(`  - target replacement width: ${targetReplacementWidth}`);
  }
  if (stakeRemediation) lines.push(`- stake remediation required: ${stakeRemediation}`);

  const criticalMissing = [];
  if (!extractLineValue(heartbeatOutput, "decision")) criticalMissing.push("decision");
  if (!extractLineValue(heartbeatOutput, "rebalance evaluation")) criticalMissing.push("rebalance evaluation");
  if (!extractLineValue(heartbeatOutput, "required heartbeat action")) criticalMissing.push("required heartbeat action");
  if (!extractLineValue(heartbeatOutput, "within range")) criticalMissing.push("within range");
  if (!extractLineValue(heartbeatOutput, "range each side")) criticalMissing.push("range each side");
  if (!(extractLineValue(heartbeatOutput, "range ticks each side now") || derivedRangeTicksEachSide)) criticalMissing.push("range ticks each side now");
  if (!(extractLineValue(heartbeatOutput, "configured ticks each side (half-width)") || derivedConfiguredTicksEachSide)) criticalMissing.push("configured ticks each side (half-width)");
  if (!extractLineValue(heartbeatOutput, "min headroom pct")) criticalMissing.push("min headroom pct");
  if (!extractLineValue(heartbeatOutput, "pending reward delta since last heartbeat")) criticalMissing.push("pending reward delta since last heartbeat");
  if (!extractLineValue(heartbeatOutput, "est apr (realized from pending delta)")) criticalMissing.push("est apr (realized from pending delta)");
  if (!extractLineValue(heartbeatOutput, "staked in configured Kittenswap farm")) criticalMissing.push("staked in configured Kittenswap farm");

  if (criticalMissing.length) {
    lines.push(`- parser warning: missing fields (${criticalMissing.join(", ")}); raw output appended`);
    lines.push("");
    lines.push("--- raw heartbeat output ---");
    lines.push(heartbeatOutput.trim());
  }

  return lines.join("\n") + "\n";
}

const walletCommand = ownerRef ? `krlp wallet ${ownerRef} --active-only` : "krlp wallet --active-only";
const walletOutput = execChat(walletCommand);
const tokenMatches = [...walletOutput.matchAll(/- token id:\s*(\d+)\b/g)].map((m) => m[1]);
if (!tokenMatches.length) {
  const ownerLabel = ownerRef || "<default-account>";
  throw new Error(`No active token IDs found for owner ${ownerLabel}.`);
}

const sorted = [...new Set(tokenMatches)].sort((a, b) => {
  const ai = BigInt(a);
  const bi = BigInt(b);
  if (ai < bi) return -1;
  if (ai > bi) return 1;
  return 0;
});
const tokenId = sorted[sorted.length - 1];

const heartbeatParts = ["krlp", "heartbeat", tokenId.toString()];
if (ownerRef) heartbeatParts.push(ownerRef);
if (recipientRef) heartbeatParts.push("--recipient", recipientRef);
heartbeatParts.push("--autonomous", "--no-next-steps");
for (const arg of heartbeatArgs) heartbeatParts.push(arg);

const heartbeatCommand = heartbeatParts.join(" ");
const heartbeatOutput = execChat(heartbeatCommand);
if (outputMode === "raw") {
  process.stdout.write(heartbeatOutput);
} else {
  process.stdout.write(buildHeartbeatSummary({ tokenId, ownerRef, recipientRef, heartbeatOutput }));
}
