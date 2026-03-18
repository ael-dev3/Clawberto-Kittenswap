#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { buildGeneratedDefaultsMarkdown, DEFAULT_HEARTBEAT, DEFAULT_POLICY } from "../skills/auto-kittenswap-lp-rebalance/scripts/krlp_defaults.mjs";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const writeMode = process.argv.includes("--write");

function replaceMarkedSection(text, marker, body) {
  const start = `<!-- ${marker}:START -->`;
  const end = `<!-- ${marker}:END -->`;
  const re = new RegExp(`${start}[\\s\\S]*?${end}`);
  if (!re.test(text)) throw new Error(`Missing marker section: ${marker}`);
  return text.replace(re, `${start}\n${body}\n${end}`);
}

function updateFile(relPath, transform) {
  const full = path.join(repoRoot, relPath);
  const before = readFileSync(full, "utf8");
  const after = transform(before);
  if (before !== after) {
    if (writeMode) writeFileSync(full, after, "utf8");
    else throw new Error(`Defaults drift in ${relPath}`);
  }
}

function syncHeartbeatExamples(text) {
  return text
    .replace(
      /heartbeat_contract_smoke\.sh <owner\|label> <owner\|label> \d+/g,
      `heartbeat_contract_smoke.sh <owner|label> <owner|label> ${DEFAULT_HEARTBEAT.edgeBps}`,
    )
    .replace(
      /heartbeat_contract_smoke\.sh <ownerLabel> <recipientLabel> \d+/g,
      `heartbeat_contract_smoke.sh <ownerLabel> <recipientLabel> ${DEFAULT_HEARTBEAT.edgeBps}`,
    )
    .replace(
      /kittenswap_guardrail_audit\.sh <owner\|label> <owner\|label> \d+/g,
      `kittenswap_guardrail_audit.sh <owner|label> <owner|label> ${DEFAULT_HEARTBEAT.edgeBps}`,
    )
    .replace(
      /kittenswap_guardrail_audit\.sh <ownerLabel> <recipientLabel> \d+/g,
      `kittenswap_guardrail_audit.sh <ownerLabel> <recipientLabel> ${DEFAULT_HEARTBEAT.edgeBps}`,
    );
}

const generatedDefaults = [
  "Defaults:",
  buildGeneratedDefaultsMarkdown({ includeHeartbeatRunbook: true }),
].join("\n");

const heartbeatDefaults = [
  `- \`--edge-bps N\` (default \`${DEFAULT_HEARTBEAT.edgeBps}\`, meaning ${(DEFAULT_HEARTBEAT.edgeBps / 100).toFixed(1)}%)`,
  "- `--autonomous` or `--no-next-steps`: suppress branch command lists and emit state-only heartbeat decision output",
  `- \`--width-bump-ticks N\` (default \`${DEFAULT_HEARTBEAT.widthBumpTicks}\`)`,
  "- `--policy <name>`",
  "- `--slippage-bps N`",
  "- `--deadline-seconds N`",
  "- `--farming-center <address>`",
  "- `--eternal-farming <address>`",
  "",
  "## Trigger policy (anti-churn)",
  "",
  "Heartbeat rebalances only when:",
  "- position is out of range, or",
  `- position is within ${(DEFAULT_HEARTBEAT.edgeBps / 100).toFixed(1)}% of an edge (\`edge-bps=${DEFAULT_HEARTBEAT.edgeBps}\`).`,
  "",
  "If neither is true, heartbeat returns `HOLD`.",
  "",
  "## Range-width policy (slow widening)",
  "",
  "When heartbeat triggers rebalance:",
  `- target replacement width = current width + \`${DEFAULT_HEARTBEAT.widthBumpTicks}\` ticks (aligned to pool tick spacing).`,
  "- this makes automatic mode widen gradually to reduce churn/volatility impact.",
  "- humans can manually tighten later; heartbeat then widens from that new width.",
].join("\n");

updateFile("README.md", (text) => {
  return syncHeartbeatExamples(replaceMarkedSection(text, "GENERATED_DEFAULTS", generatedDefaults));
});

updateFile("skills/auto-kittenswap-lp-rebalance/SKILL.md", (text) => {
  return syncHeartbeatExamples(
    replaceMarkedSection(text, "GENERATED_DEFAULTS", buildGeneratedDefaultsMarkdown({ includeHeartbeatRunbook: true })),
  );
});

updateFile("skills/auto-kittenswap-lp-rebalance/references/openclaw-instance-porting.md", syncHeartbeatExamples);
updateFile("skills/auto-kittenswap-lp-rebalance/references/rebalance-playbook.md", syncHeartbeatExamples);

updateFile("HEARTBEAT.md", (text) => replaceMarkedSection(text, "GENERATED_HEARTBEAT_DEFAULTS", heartbeatDefaults));

if (!writeMode) {
  process.stdout.write("Defaults docs are in sync.\n");
}
