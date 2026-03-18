import { readFileSync } from "node:fs";

const DEFAULTS_URL = new URL("../../../policy.defaults.json", import.meta.url);

function loadDefaults() {
  const parsed = JSON.parse(readFileSync(DEFAULTS_URL, "utf8"));
  if (!parsed || typeof parsed !== "object") {
    throw new Error("policy.defaults.json must be an object");
  }
  if (parsed.schemaVersion !== 1) {
    throw new Error(`Unsupported policy.defaults.json schemaVersion: ${parsed.schemaVersion}`);
  }
  const defaults = parsed.defaults;
  if (!defaults || typeof defaults !== "object") {
    throw new Error("policy.defaults.json missing defaults object");
  }
  return Object.freeze(parsed);
}

export const CANONICAL_DEFAULTS = loadDefaults();
export const CANONICAL_DEFAULTS_PATH = "policy.defaults.json";

export const DEFAULT_POLICY = Object.freeze({
  edgeBps: Number(CANONICAL_DEFAULTS.defaults.policy?.default?.edgeBps ?? 1500),
  slippageBps: Number(CANONICAL_DEFAULTS.defaults.policy?.default?.slippageBps ?? 50),
  deadlineSeconds: Number(CANONICAL_DEFAULTS.defaults.policy?.default?.deadlineSeconds ?? 900),
});

export const DEFAULT_HEARTBEAT = Object.freeze({
  edgeBps: Number(CANONICAL_DEFAULTS.defaults.heartbeat?.edgeBps ?? 850),
  widthBumpTicks: Number(CANONICAL_DEFAULTS.defaults.heartbeat?.widthBumpTicks ?? 100),
  autonomous: Boolean(CANONICAL_DEFAULTS.defaults.heartbeat?.autonomous ?? true),
  noNextSteps: Boolean(CANONICAL_DEFAULTS.defaults.heartbeat?.noNextSteps ?? true),
});

export const DEFAULT_GENERAL = Object.freeze({
  heartbeatAutonomous: DEFAULT_HEARTBEAT.autonomous,
  heartbeatNoNextSteps: DEFAULT_HEARTBEAT.noNextSteps,
});

export const DEFAULT_APR_HALF_RANGE_TICKS = Object.freeze(
  [...(CANONICAL_DEFAULTS.defaults.apr?.halfRangeTicks ?? [50, 100, 200, 300, 500, 750, 1000])].map((value) => Number(value)),
);

export const OWNER_TOKEN_ENUMERATION_LIMIT = Number(
  CANONICAL_DEFAULTS.defaults.validation?.ownerTokenEnumerationLimit ?? 500,
);

export function fmtBpsPct(bps) {
  const n = Number(bps);
  if (!Number.isFinite(n)) return "n/a";
  return `${(n / 100).toFixed(2)}%`;
}

export function defaultsSnapshot() {
  return {
    schemaVersion: CANONICAL_DEFAULTS.schemaVersion,
    path: CANONICAL_DEFAULTS_PATH,
    policy: { ...DEFAULT_POLICY },
    heartbeat: { ...DEFAULT_HEARTBEAT },
    apr: {
      halfRangeTicks: [...DEFAULT_APR_HALF_RANGE_TICKS],
    },
    validation: {
      ownerTokenEnumerationLimit: OWNER_TOKEN_ENUMERATION_LIMIT,
    },
  };
}

export function buildGeneratedDefaultsMarkdown({ includeHeartbeatRunbook = false } = {}) {
  const lines = [
    `- Policy default edge threshold: \`${DEFAULT_POLICY.edgeBps}\` bps (${fmtBpsPct(DEFAULT_POLICY.edgeBps)})`,
    `- Policy default slippage guard: \`${DEFAULT_POLICY.slippageBps}\` bps`,
    `- Policy default deadline: \`${DEFAULT_POLICY.deadlineSeconds}\` seconds`,
    `- Heartbeat default edge threshold: \`${DEFAULT_HEARTBEAT.edgeBps}\` bps (${fmtBpsPct(DEFAULT_HEARTBEAT.edgeBps)})`,
    `- Heartbeat width bump on triggered rebalance: \`+${DEFAULT_HEARTBEAT.widthBumpTicks}\` ticks`,
    `- Heartbeat autonomous default: \`${DEFAULT_HEARTBEAT.autonomous ? "enabled" : "disabled"}\``,
    `- Heartbeat state-only default: \`${DEFAULT_HEARTBEAT.noNextSteps ? "enabled" : "disabled"}\``,
  ];
  if (includeHeartbeatRunbook) {
    lines.push(`- Active-token helper examples should pass \`--edge-bps ${DEFAULT_HEARTBEAT.edgeBps}\` when they want an explicit threshold override.`);
  }
  return lines.join("\n");
}
