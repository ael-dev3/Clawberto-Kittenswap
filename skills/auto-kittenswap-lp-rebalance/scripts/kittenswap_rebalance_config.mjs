// Local config for Kittenswap rebalance skill.
// Stores account aliases + default policy in ~/.clawdbot/kittenswap/rebalance_config.json

import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { assertAddress, normalizeAddress } from "./kittenswap_rebalance_api.mjs";

export const DEFAULT_POLICY = Object.freeze({
  edgeBps: 1500,
  slippageBps: 50,
  deadlineSeconds: 900,
});

export function defaultConfigPath() {
  return process.env.CLAWDBOT_KITTENSWAP_CONFIG ||
    path.join(os.homedir(), ".clawdbot", "kittenswap", "rebalance_config.json");
}

export function normalizeLabel(label) {
  return String(label ?? "").trim().toLowerCase();
}

function cloneDefaultPolicy() {
  return {
    edgeBps: DEFAULT_POLICY.edgeBps,
    slippageBps: DEFAULT_POLICY.slippageBps,
    deadlineSeconds: DEFAULT_POLICY.deadlineSeconds,
  };
}

function normalizePolicy(policy) {
  const p = policy && typeof policy === "object" ? policy : {};
  const edgeBps = Number.isFinite(Number(p.edgeBps)) ? Math.max(0, Math.min(10_000, Math.floor(Number(p.edgeBps)))) : DEFAULT_POLICY.edgeBps;
  const slippageBps = Number.isFinite(Number(p.slippageBps)) ? Math.max(0, Math.min(10_000, Math.floor(Number(p.slippageBps)))) : DEFAULT_POLICY.slippageBps;
  const deadlineSeconds = Number.isFinite(Number(p.deadlineSeconds)) ? Math.max(1, Math.min(86_400, Math.floor(Number(p.deadlineSeconds)))) : DEFAULT_POLICY.deadlineSeconds;
  return { edgeBps, slippageBps, deadlineSeconds };
}

export function normalizeConfig(cfg) {
  const c = cfg && typeof cfg === "object" ? cfg : {};

  if (!c.accounts || typeof c.accounts !== "object") c.accounts = {};
  const normalizedAccounts = {};
  for (const [k, v] of Object.entries(c.accounts)) {
    const key = normalizeLabel(k);
    const addr = normalizeAddress(v);
    if (key && addr) normalizedAccounts[key] = addr;
  }
  c.accounts = normalizedAccounts;

  if (c.defaultAccount != null) {
    const key = normalizeLabel(c.defaultAccount);
    c.defaultAccount = c.accounts[key] ? key : undefined;
  }

  if (!c.policies || typeof c.policies !== "object") c.policies = {};
  const policies = {};
  for (const [k, p] of Object.entries(c.policies)) {
    const key = normalizeLabel(k);
    if (!key) continue;
    policies[key] = normalizePolicy(p);
  }
  if (!policies.default) policies.default = cloneDefaultPolicy();
  c.policies = policies;

  const defaultPolicy = normalizeLabel(c.defaultPolicy || "default");
  c.defaultPolicy = c.policies[defaultPolicy] ? defaultPolicy : "default";

  return c;
}

export async function loadConfig({ configPath = defaultConfigPath() } = {}) {
  try {
    const raw = await fs.readFile(configPath, "utf8");
    return normalizeConfig(JSON.parse(raw));
  } catch (e) {
    if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) return normalizeConfig({});
    throw e;
  }
}

export async function saveConfig(cfg, { configPath = defaultConfigPath() } = {}) {
  const normalized = normalizeConfig(cfg);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(normalized, null, 2) + "\n", "utf8");
}

export async function setAccountAlias({ label, address, makeDefault = false, configPath } = {}) {
  const cfg = await loadConfig({ configPath });
  const key = normalizeLabel(label);
  if (!key) throw new Error("Missing label (example: 'main').");
  cfg.accounts[key] = assertAddress(address);
  if (makeDefault) cfg.defaultAccount = key;
  await saveConfig(cfg, { configPath });
  return cfg;
}

export async function removeAccountAlias({ label, configPath } = {}) {
  const cfg = await loadConfig({ configPath });
  const key = normalizeLabel(label);
  if (!key) throw new Error("Missing label.");
  delete cfg.accounts[key];
  if (cfg.defaultAccount === key) delete cfg.defaultAccount;
  await saveConfig(cfg, { configPath });
  return cfg;
}

export async function setDefaultAccount({ label, configPath } = {}) {
  const cfg = await loadConfig({ configPath });
  const key = normalizeLabel(label);
  if (!key) throw new Error("Missing label.");
  if (!cfg.accounts[key]) throw new Error(`Unknown saved account: ${label}`);
  cfg.defaultAccount = key;
  await saveConfig(cfg, { configPath });
  return cfg;
}

export async function resolveAccountRef(ref, { configPath } = {}) {
  const asAddr = normalizeAddress(ref);
  if (asAddr) return { address: asAddr, label: null, source: "address" };

  const cfg = await loadConfig({ configPath });
  const key = normalizeLabel(ref);

  if (!key) {
    if (cfg.defaultAccount && cfg.accounts[cfg.defaultAccount]) {
      return {
        address: cfg.accounts[cfg.defaultAccount],
        label: cfg.defaultAccount,
        source: "default",
      };
    }
    return { address: null, label: null, source: "missing" };
  }

  if (cfg.accounts[key]) return { address: cfg.accounts[key], label: key, source: "alias" };
  return { address: null, label: key, source: "unknown" };
}

export async function listPolicies({ configPath } = {}) {
  const cfg = await loadConfig({ configPath });
  return cfg.policies;
}

export async function getPolicy(ref = "", { configPath } = {}) {
  const cfg = await loadConfig({ configPath });
  const key = normalizeLabel(ref || cfg.defaultPolicy || "default");
  const policy = cfg.policies[key];
  if (!policy) throw new Error(`Unknown policy: ${ref}`);
  return { key, policy };
}

export async function upsertPolicy({
  name = "default",
  edgeBps,
  slippageBps,
  deadlineSeconds,
  makeDefault = false,
  configPath,
} = {}) {
  const cfg = await loadConfig({ configPath });
  const key = normalizeLabel(name || "default");
  if (!key) throw new Error("Policy name cannot be empty.");

  const base = cfg.policies[key] || cloneDefaultPolicy();
  cfg.policies[key] = normalizePolicy({
    edgeBps: edgeBps ?? base.edgeBps,
    slippageBps: slippageBps ?? base.slippageBps,
    deadlineSeconds: deadlineSeconds ?? base.deadlineSeconds,
  });
  if (makeDefault) cfg.defaultPolicy = key;
  await saveConfig(cfg, { configPath });
  return { key, policy: cfg.policies[key], defaultPolicy: cfg.defaultPolicy };
}

