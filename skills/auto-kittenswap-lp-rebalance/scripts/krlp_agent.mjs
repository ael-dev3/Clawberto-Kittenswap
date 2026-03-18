#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const CHAT_SCRIPT_PATH = fileURLToPath(new URL("./kittenswap_rebalance_chat.mjs", import.meta.url));

function readRawInput() {
  if (process.argv.length > 2) return process.argv.slice(2).join(" ").trim();
  try {
    return readFileSync(0, "utf8").trim();
  } catch {
    return "";
  }
}

function quoteArg(value) {
  const s = String(value ?? "");
  if (!s) return '""';
  if (/^[A-Za-z0-9_./:-]+$/.test(s)) return s;
  return JSON.stringify(s);
}

function normalizeJsonInput(raw) {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Strict JSON input must be an object.");
  }
  if (Array.isArray(parsed.argv)) {
    return parsed.argv.map((value) => String(value));
  }
  const command = String(parsed.command || "").trim();
  if (!command) throw new Error("Strict JSON input requires command or argv.");
  const args = Array.isArray(parsed.args) ? parsed.args.map((value) => String(value)) : [];
  return [command, ...args];
}

function normalizeCommandInput(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) throw new Error("Usage: krlp-agent '<canonical command>' or JSON input.");
  if (trimmed.startsWith("{")) return normalizeJsonInput(trimmed);
  return trimmed.split(/\s+/);
}

const argv = normalizeCommandInput(readRawInput());
const joined = argv.map(quoteArg).join(" ");
const child = spawnSync("node", [CHAT_SCRIPT_PATH, `${joined} --strict --json`], {
  encoding: "utf8",
  maxBuffer: 12_000_000,
  timeout: 180000,
});

if (child.error) throw child.error;
if (child.status !== 0) {
  process.stderr.write(child.stderr || child.stdout || `krlp_agent failed: ${child.status}\n`);
  process.exit(child.status || 1);
}
process.stdout.write(child.stdout);
