#!/usr/bin/env node
// Resolve the current active tokenId for an owner and run heartbeat plan on it.

import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const rawArgs = process.argv.slice(2);
const isFlag = (value) => String(value || "").startsWith("--");

const scriptPath = fileURLToPath(new URL("./kittenswap_rebalance_chat.mjs", import.meta.url));

let ownerRef = "farcaster";
let recipientRef = "";
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
  heartbeatArgs.push(arg);
}

if (!recipientRef) recipientRef = ownerRef;

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

const walletOutput = execChat(`krlp wallet ${ownerRef} --active-only`);
const tokenMatches = [...walletOutput.matchAll(/- token id:\s*(\d+)\b/g)].map((m) => m[1]);
if (!tokenMatches.length) {
  throw new Error(`No active token IDs found for owner ${ownerRef}.`);
}

const sorted = [...new Set(tokenMatches)].sort((a, b) => {
  const ai = BigInt(a);
  const bi = BigInt(b);
  if (ai < bi) return -1;
  if (ai > bi) return 1;
  return 0;
});
const tokenId = sorted[sorted.length - 1];

let heartbeatCommand = `krlp heartbeat ${tokenId} ${ownerRef}`;
heartbeatCommand += ` --recipient ${recipientRef}`;
for (const arg of heartbeatArgs) {
  heartbeatCommand += ` ${arg}`;
}

const heartbeatOutput = execChat(heartbeatCommand);
process.stdout.write(heartbeatOutput);
