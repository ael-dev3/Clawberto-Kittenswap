import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const CHAT_SCRIPT_PATH = fileURLToPath(new URL("./kittenswap_rebalance_chat.mjs", import.meta.url));

export function isFlag(value) {
  return String(value || "").startsWith("--");
}

export function sleepMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, Math.floor(ms));
}

export function execChat(input) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const run = spawnSync("node", [CHAT_SCRIPT_PATH, input], {
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

export function extractTokenIds(walletOutput) {
  return [...String(walletOutput || "").matchAll(/- token id:\s*(\d+)\b/g)].map((match) => match[1]);
}

export function sortTokenIds(tokenIds = []) {
  return [...new Set(tokenIds)].sort((a, b) => {
    const ai = BigInt(a);
    const bi = BigInt(b);
    if (ai < bi) return -1;
    if (ai > bi) return 1;
    return 0;
  });
}

export function resolveActiveTokenId(ownerRef = "") {
  const walletCommand = ownerRef ? `krlp wallet ${ownerRef} --active-only` : "krlp wallet --active-only";
  let walletOutput = execChat(walletCommand);
  let tokenMatches = extractTokenIds(walletOutput);

  if (!tokenMatches.length) {
    const walletFallbackCommand = ownerRef ? `krlp wallet ${ownerRef}` : "krlp wallet";
    walletOutput = execChat(walletFallbackCommand);
    tokenMatches = extractTokenIds(walletOutput);
  }

  const sorted = sortTokenIds(tokenMatches);
  return {
    tokenId: sorted.length ? sorted[sorted.length - 1] : null,
    walletOutput,
    tokenIds: sorted,
  };
}

export function parseOwnerAndArgs(rawArgs = []) {
  const args = [...rawArgs];
  let ownerRef = "";
  if (args.length > 0 && !isFlag(args[0])) {
    ownerRef = args.shift();
  }
  return { ownerRef, passthroughArgs: args };
}

export function runResolvedTokenCommand({ command, ownerRef = "", passthroughArgs = [], includeOwnerRef = false } = {}) {
  const resolved = resolveActiveTokenId(ownerRef);
  if (!resolved.tokenId) {
    const ownerLabel = ownerRef || "<default-account>";
    return {
      ...resolved,
      command: null,
      noActivePosition: true,
      output: `No active token IDs found for owner ${ownerLabel}.\n`,
    };
  }
  const parts = ["krlp", command, resolved.tokenId];
  if (includeOwnerRef && ownerRef) parts.push(ownerRef);
  parts.push(...passthroughArgs);
  const output = execChat(parts.join(" "));
  return { ...resolved, command: parts.join(" "), noActivePosition: false, output };
}
