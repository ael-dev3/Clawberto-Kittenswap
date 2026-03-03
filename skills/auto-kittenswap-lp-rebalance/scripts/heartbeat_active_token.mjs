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
let outputMode = "summary"; // summary | raw | contract | highlight
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
  if (arg === "--contract") {
    outputMode = "contract";
    continue;
  }
  if (arg === "--highlight") {
    outputMode = "highlight";
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

function collectHeartbeatData({ tokenId, ownerRef, recipientRef, heartbeatOutput }) {
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

  const txHashes = [...new Set((heartbeatOutput.match(/0x[a-fA-F0-9]{64}/g) || []))];
  const postActionStatus = extractLineValueByPrefix(heartbeatOutput, "post-action status")
    || extractLineValueByPrefix(heartbeatOutput, "post-check status");
  const newTokenMatch = heartbeatOutput.match(/new tokenid[^0-9]*(\d+)/i);
  const newTokenId = newTokenMatch ? newTokenMatch[1] : null;
  const blockerLine = heartbeatOutput
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /blocker|blocked/i.test(line));
  const blockerReason = blockerLine ? blockerLine.replace(/^-\s*/, "") : null;

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

  return {
    tokenId,
    ownerSender,
    recipient,
    decision,
    rebalanceEvaluation,
    requiredAction,
    ticks,
    withinRange,
    rangeEachSide,
    rangeTicksEachSide,
    configuredTicksEachSide,
    tickSideStatus,
    minHeadroom,
    threshold,
    stakeStatusCode,
    stakedInFarm,
    stakeIntegrity,
    pendingRewardNow,
    pendingRewardDelta,
    realizedApr,
    rewardMarkPrice,
    lpPrincipalMark,
    pendingBonusNow,
    heartbeatMode,
    branch,
    triggerRangeEachSide,
    triggerTicksEachSide,
    triggerMinHeadroom,
    suggestedReplacementRange,
    targetReplacementWidth,
    stakeRemediation,
    txHashes,
    postActionStatus,
    newTokenId,
    blockerReason,
    criticalMissing,
    heartbeatOutput,
  };
}

function buildHeartbeatSummary(params) {
  const d = collectHeartbeatData(params);

  const lines = [];
  lines.push(`Kittenswap heartbeat summary (${d.tokenId})`);
  if (d.ownerSender === d.recipient) {
    lines.push(`- owner/recipient: ${d.ownerSender}`);
  } else {
    lines.push(`- owner/sender: ${d.ownerSender}`);
    lines.push(`- recipient: ${d.recipient}`);
  }
  lines.push(`- decision: ${d.decision} | rebalance: ${d.rebalanceEvaluation} | action: ${d.requiredAction}`);
  lines.push(`- range: ${d.ticks} | in-range ${d.withinRange}`);
  lines.push(`- range each side: ${d.rangeEachSide}`);
  lines.push(`- ticks each side now: ${d.rangeTicksEachSide}`);
  lines.push(`- configured ticks each side: ${d.configuredTicksEachSide}`);
  if (d.tickSideStatus) lines.push(`- tick side status: ${d.tickSideStatus}`);
  lines.push(`- min headroom: ${d.minHeadroom} (threshold ${d.threshold})`);
  lines.push(`- stake: ${d.stakeStatusCode} | configured farm ${d.stakedInFarm} | integrity ${d.stakeIntegrity}`);
  lines.push(`- pending reward now: ${d.pendingRewardNow}`);
  lines.push(`- pending reward delta: ${d.pendingRewardDelta}`);
  lines.push(`- reward mark price: ${d.rewardMarkPrice}`);
  lines.push(`- lp principal mark: ${d.lpPrincipalMark}`);
  lines.push(`- est apr: ${d.realizedApr}`);
  if (d.pendingBonusNow) lines.push(`- pending bonus now: ${d.pendingBonusNow}`);
  lines.push(`- mode/branch: ${d.heartbeatMode} / ${d.branch}`);

  if (d.triggerRangeEachSide || d.triggerTicksEachSide || d.triggerMinHeadroom || d.suggestedReplacementRange || d.targetReplacementWidth) {
    lines.push("- trigger context:");
    if (d.triggerRangeEachSide) lines.push(`  - range each side: ${d.triggerRangeEachSide}`);
    if (d.triggerTicksEachSide) lines.push(`  - ticks each side: ${d.triggerTicksEachSide}`);
    if (d.triggerMinHeadroom) lines.push(`  - min headroom: ${d.triggerMinHeadroom}`);
    if (d.suggestedReplacementRange) lines.push(`  - suggested replacement range: ${d.suggestedReplacementRange}`);
    if (d.targetReplacementWidth) lines.push(`  - target replacement width: ${d.targetReplacementWidth}`);
  }
  if (d.stakeRemediation) lines.push(`- stake remediation required: ${d.stakeRemediation}`);

  if (d.criticalMissing.length) {
    lines.push(`- parser warning: missing fields (${d.criticalMissing.join(", ")}); raw output appended`);
    lines.push("");
    lines.push("--- raw heartbeat output ---");
    lines.push(d.heartbeatOutput.trim());
  }

  return lines.join("\n") + "\n";
}

function buildHeartbeatHighlight(params) {
  const d = collectHeartbeatData(params);
  const lines = [];

  const triggerRequested = /rebalance_compound_restake/i.test(`${d.decision} ${d.requiredAction}`);
  let actionDisplay = d.requiredAction;
  if (triggerRequested && !/executed|blocked/i.test(actionDisplay)) {
    actionDisplay = d.txHashes.length >= 6
      ? `${actionDisplay} executed`
      : `${actionDisplay} blocked (missing tx evidence)`;
  }
  const actionNorm = String(actionDisplay || "").trim().toUpperCase();

  const normalizeRewardText = (value) => String(value ?? "n/a").replace(/\bTOKEN\b/g, "KITTEN");
  const pendingNowDisplay = normalizeRewardText(d.pendingRewardNow);
  const pendingDeltaDisplay = normalizeRewardText(d.pendingRewardDelta);

  lines.push(`Heartbeat update (${d.tokenId}): ${d.decision}.`);
  lines.push("Highlights:");
  lines.push(`• Rebalance evaluation: ${d.rebalanceEvaluation}`);
  lines.push(`• Required heartbeat action: ${actionDisplay}`);
  lines.push(`• Range each side: ${d.rangeEachSide}`);
  lines.push(`• Min headroom: ${d.minHeadroom}${d.threshold && d.threshold !== "n/a" ? ` (threshold ${d.threshold})` : ""}`);
  lines.push(`• Pending reward now: ${pendingNowDisplay}`);
  lines.push(`• Pending reward delta: ${pendingDeltaDisplay}`);
  lines.push(`• Est APR: ${d.realizedApr}`);

  lines.push("");
  lines.push("Key status:");
  lines.push(`• Ticks each side now: ${d.rangeTicksEachSide}`);
  lines.push(`• Configured ticks each side: ${d.configuredTicksEachSide}`);
  lines.push(`• Stake status: ${d.stakeStatusCode} | farm ${d.stakedInFarm} | integrity ${d.stakeIntegrity}`);

  if (/executed/i.test(actionDisplay) && d.txHashes.length) {
    lines.push(`• Tx hashes: ${d.txHashes.join(" ")}`);
  }
  if (/blocked/i.test(actionDisplay) && d.blockerReason) {
    lines.push(`• Blocker: ${d.blockerReason}`);
  }
  if (d.postActionStatus || d.newTokenId) {
    const postBits = [];
    if (d.newTokenId) postBits.push(`new tokenId ${d.newTokenId}`);
    if (d.postActionStatus) postBits.push(d.postActionStatus);
    lines.push(`• Post-action tokenId/status: ${postBits.join(" | ")}`);
  }

  lines.push("");
  if (actionNorm === "NONE") {
    lines.push("Outcome: No action required this cycle.");
  } else {
    lines.push(`Outcome: Action required this cycle: ${actionDisplay}.`);
  }

  return lines.join("\n") + "\n";
}

function buildHeartbeatContract(params) {
  const d = collectHeartbeatData(params);
  const lines = [];

  const triggerRequested = /rebalance_compound_restake/i.test(`${d.decision} ${d.requiredAction}`);
  let actionDisplay = d.requiredAction;
  if (triggerRequested && !/executed|blocked/i.test(actionDisplay)) {
    actionDisplay = d.txHashes.length >= 6
      ? `${actionDisplay} executed`
      : `${actionDisplay} blocked (missing tx evidence)`;
  }

  lines.push(`decision: ${d.decision}`);
  lines.push(`rebalance evaluation: ${d.rebalanceEvaluation}`);
  lines.push(`required heartbeat action: ${actionDisplay}`);
  lines.push(`range each side: ${d.rangeEachSide}`);
  lines.push(`ticks each side now: ${d.rangeTicksEachSide}`);
  lines.push(`configured ticks each side: ${d.configuredTicksEachSide}`);
  lines.push(`min headroom: ${d.minHeadroom}${d.threshold && d.threshold !== "n/a" ? ` (threshold ${d.threshold})` : ""}`);
  lines.push(`pending reward delta: ${d.pendingRewardDelta}`);
  lines.push(`est apr: ${d.realizedApr}`);

  if (/executed/i.test(actionDisplay) && d.txHashes.length) {
    lines.push(`tx hashes: ${d.txHashes.join(" ")}`);
  }
  if (/blocked/i.test(actionDisplay) && d.blockerReason) {
    lines.push(`blocker: ${d.blockerReason}`);
  }

  if (d.postActionStatus || d.newTokenId) {
    const postBits = [];
    if (d.newTokenId) postBits.push(`new tokenId ${d.newTokenId}`);
    if (d.postActionStatus) postBits.push(d.postActionStatus);
    lines.push(`post-action tokenId/status: ${postBits.join(" | ")}`);
  } else {
    lines.push(`post-action tokenId/status: ${d.stakeStatusCode}, farm configured: ${d.stakedInFarm}, integrity: ${d.stakeIntegrity}`);
  }

  return lines.join("\n") + "\n";
}

const walletCommand = ownerRef ? `krlp wallet ${ownerRef} --active-only` : "krlp wallet --active-only";
let walletOutput = execChat(walletCommand);
let tokenMatches = [...walletOutput.matchAll(/- token id:\s*(\d+)\b/g)].map((m) => m[1]);
if (!tokenMatches.length) {
  const walletFallbackCommand = ownerRef ? `krlp wallet ${ownerRef}` : "krlp wallet";
  walletOutput = execChat(walletFallbackCommand);
  tokenMatches = [...walletOutput.matchAll(/- token id:\s*(\d+)\b/g)].map((m) => m[1]);
}
if (!tokenMatches.length) {
  const ownerLabel = ownerRef || "<default-account>";
  const recipientLabel = recipientRef || ownerLabel;
  const edgeIdx = heartbeatArgs.findIndex((arg) => arg === "--edge-bps");
  const edgeBps = edgeIdx >= 0 && heartbeatArgs[edgeIdx + 1] && !isFlag(heartbeatArgs[edgeIdx + 1])
    ? heartbeatArgs[edgeIdx + 1]
    : "n/a";

  const noActiveSummaryLines = [
    "Kittenswap heartbeat summary (no-active-position)",
    ownerLabel === recipientLabel ? `- owner/recipient: ${ownerLabel}` : `- owner/sender: ${ownerLabel}`,
    ownerLabel === recipientLabel ? null : `- recipient: ${recipientLabel}`,
    "- decision: HOLD | rebalance: NO_ACTIVE_POSITION | action: NONE",
    "- range: n/a | in-range n/a",
    "- range each side: n/a",
    "- ticks each side now: n/a",
    "- configured ticks each side: n/a",
    "- tick side status: n/a",
    `- min headroom: n/a (threshold ${edgeBps} bps)`,
    "- stake: NO_ACTIVE_POSITION | configured farm n/a | integrity n/a",
    "- pending reward now: n/a",
    "- pending reward delta: n/a",
    "- reward mark price: n/a",
    "- lp principal mark: n/a",
    "- est apr: n/a",
    "- mode/branch: autonomous / HOLD",
    `- note: No active token IDs found for owner ${ownerLabel}.`,
  ].filter(Boolean);

  const noActiveContractLines = [
    "decision: HOLD",
    "rebalance evaluation: NO_ACTIVE_POSITION",
    "required heartbeat action: NONE",
    "range each side: n/a",
    "ticks each side now: n/a",
    "configured ticks each side: n/a",
    `min headroom: n/a (threshold ${edgeBps} bps)`,
    "pending reward delta: n/a",
    "est apr: n/a",
    "post-action tokenId/status: NO_ACTIVE_POSITION, farm configured: n/a, integrity: n/a",
  ];

  const noActiveHighlightLines = [
    "Heartbeat update (no-active-position): HOLD.",
    "Key status:",
    "• Rebalance evaluation: NO_ACTIVE_POSITION",
    "• Required heartbeat action: NONE",
    "• Range each side: n/a",
    "• Ticks each side now: n/a",
    "• Configured ticks each side: n/a",
    `• Min headroom: n/a (threshold ${edgeBps} bps)`,
    "",
    "Staking/rewards:",
    "• Stake status: NO_ACTIVE_POSITION",
    "• Staked in configured farm: n/a",
    "• Stake integrity: n/a",
    "• Pending reward now: n/a",
    "• Pending reward delta: n/a",
    "• Est APR: n/a",
    "",
    `Outcome: No active token IDs found for owner ${ownerLabel}.`,
  ];

  if (outputMode === "raw") {
    process.stdout.write(`No active token IDs found for owner ${ownerLabel}.\n`);
  } else if (outputMode === "contract") {
    process.stdout.write(noActiveContractLines.join("\n") + "\n");
  } else if (outputMode === "highlight") {
    process.stdout.write(noActiveHighlightLines.join("\n") + "\n");
  } else {
    process.stdout.write(noActiveSummaryLines.join("\n") + "\n");
  }
  process.exit(0);
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
} else if (outputMode === "contract") {
  process.stdout.write(buildHeartbeatContract({ tokenId, ownerRef, recipientRef, heartbeatOutput }));
} else if (outputMode === "highlight") {
  process.stdout.write(buildHeartbeatHighlight({ tokenId, ownerRef, recipientRef, heartbeatOutput }));
} else {
  process.stdout.write(buildHeartbeatSummary({ tokenId, ownerRef, recipientRef, heartbeatOutput }));
}
