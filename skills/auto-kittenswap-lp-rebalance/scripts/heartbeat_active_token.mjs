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

function execChat(input) {
  const run = spawnSync("node", [scriptPath, input], {
    encoding: "utf8",
    maxBuffer: 12_000_000,
    timeout: 180000,
  });
  if (run.error) throw run.error;
  if (run.status !== 0) {
    throw new Error(run.stderr || run.stdout || `chat command failed: ${run.status}`);
  }
  return run.stdout;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractLineValue(text, label) {
  const re = new RegExp(`^- ${escapeRegExp(label)}: (.+)$`, "m");
  const match = text.match(re);
  return match ? match[1].trim() : null;
}

function buildHeartbeatSummary({ tokenId, ownerRef, recipientRef, heartbeatOutput }) {
  const get = (label) => extractLineValue(heartbeatOutput, label);

  const ownerSender = get("owner/sender") || ownerRef || "<default-account-resolved>";
  const recipient = get("recipient") || recipientRef || ownerSender;
  const ticks = get("ticks") || "n/a";
  const withinRange = get("within range") || "n/a";
  const rangeEachSide = get("range each side") || "n/a";
  const minHeadroom = get("min headroom pct") || "n/a";
  const threshold = get("heartbeat edge threshold") || "n/a";
  const rebalanceEvaluation = get("rebalance evaluation") || "n/a";
  const decision = get("decision") || "n/a";
  const requiredAction = get("required heartbeat action") || "n/a";
  const stakeStatusCode = get("canonical stake status code") || "n/a";
  const stakedInFarm = get("staked in configured Kittenswap farm") || "n/a";
  const stakeIntegrity = get("stake integrity") || "n/a";
  const pendingRewardNow = get("pending reward now") || "n/a";
  const pendingBonusNow = get("pending bonus now");
  const heartbeatMode = get("heartbeat mode") || "n/a";
  const branch = get("branch") || decision;
  const triggerRangeEachSide = get("trigger position range each side");
  const triggerMinHeadroom = get("trigger position min headroom");
  const suggestedReplacementRange = get("suggested replacement range");
  const targetReplacementWidth = get("target replacement width");
  const stakeRemediation = get("stake remediation required");

  const lines = [];
  lines.push(`Kittenswap heartbeat summary (${tokenId})`);
  lines.push(`- owner/sender: ${ownerSender}`);
  lines.push(`- recipient: ${recipient}`);
  lines.push(`- decision: ${decision}`);
  lines.push(`- rebalance evaluation: ${rebalanceEvaluation}`);
  lines.push(`- required heartbeat action: ${requiredAction}`);
  lines.push(`- ticks: ${ticks}`);
  lines.push(`- within range: ${withinRange}`);
  lines.push(`- range each side: ${rangeEachSide}`);
  lines.push(`- min headroom pct: ${minHeadroom}`);
  lines.push(`- edge threshold: ${threshold}`);
  lines.push(`- stake status code: ${stakeStatusCode}`);
  lines.push(`- staked in configured Kittenswap farm: ${stakedInFarm}`);
  lines.push(`- stake integrity: ${stakeIntegrity}`);
  lines.push(`- pending reward now: ${pendingRewardNow}`);
  if (pendingBonusNow) lines.push(`- pending bonus now: ${pendingBonusNow}`);
  lines.push(`- heartbeat mode: ${heartbeatMode}`);
  lines.push(`- branch: ${branch}`);

  if (triggerRangeEachSide) lines.push(`- trigger position range each side: ${triggerRangeEachSide}`);
  if (triggerMinHeadroom) lines.push(`- trigger position min headroom: ${triggerMinHeadroom}`);
  if (suggestedReplacementRange) lines.push(`- suggested replacement range: ${suggestedReplacementRange}`);
  if (targetReplacementWidth) lines.push(`- target replacement width: ${targetReplacementWidth}`);
  if (stakeRemediation) lines.push(`- stake remediation required: ${stakeRemediation}`);

  const criticalMissing = [];
  if (!extractLineValue(heartbeatOutput, "decision")) criticalMissing.push("decision");
  if (!extractLineValue(heartbeatOutput, "rebalance evaluation")) criticalMissing.push("rebalance evaluation");
  if (!extractLineValue(heartbeatOutput, "within range")) criticalMissing.push("within range");
  if (!extractLineValue(heartbeatOutput, "range each side")) criticalMissing.push("range each side");
  if (!extractLineValue(heartbeatOutput, "min headroom pct")) criticalMissing.push("min headroom pct");
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
