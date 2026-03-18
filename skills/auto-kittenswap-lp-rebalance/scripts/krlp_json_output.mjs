import { readFileSync } from "node:fs";

import { defaultsSnapshot } from "./krlp_defaults.mjs";

const MANIFEST_URL = new URL("../commands.manifest.json", import.meta.url);
const COMMAND_MANIFEST = Object.freeze(JSON.parse(readFileSync(MANIFEST_URL, "utf8")));

function toCamel(label) {
  const compact = String(label || "")
    .trim()
    .replace(/[^A-Za-z0-9]+(.)/g, (_match, ch) => (ch ? ch.toUpperCase() : ""))
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/[^A-Za-z0-9]/g, "");
  return compact ? compact[0].toLowerCase() + compact.slice(1) : "";
}

function scalarValue(raw) {
  if (raw == null) return null;
  const value = String(raw).trim();
  if (!value) return "";
  if (/^(yes|no)$/i.test(value)) return /^yes$/i.test(value);
  if (/^(pass|fail|blocked)$/i.test(value)) return value.toUpperCase();
  if (/^(true|false)$/i.test(value)) return /^true$/i.test(value);
  if (/^-?\d+$/.test(value)) {
    const asNumber = Number(value);
    if (Number.isSafeInteger(asNumber)) return asNumber;
  }
  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) return asNumber;
  }
  return value;
}

function parseBulletTree(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const title = (lines.find((line) => line.trim()) || "").trim();
  const root = [];
  const stack = [{ indent: -1, children: root }];
  const freeform = [];

  for (const rawLine of lines.slice(1)) {
    const line = rawLine.replace(/\t/g, "    ");
    const match = line.match(/^(\s*)-\s([^:]+?)(?::\s*(.*))?$/);
    if (!match) {
      if (line.trim()) freeform.push(line.trim());
      continue;
    }
    const indent = Math.floor(match[1].length / 2);
    const label = match[2].trim();
    const value = match[3] == null ? null : match[3].trim();
    const node = { label, key: toCamel(label), value, children: [] };
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    stack[stack.length - 1].children.push(node);
    stack.push({ indent, children: node.children });
  }

  return { title, tree: root, freeform };
}

function topLevelFields(tree) {
  const labeledFields = {};
  const fields = {};
  for (const node of tree) {
    if (node.value == null) continue;
    labeledFields[node.label] = node.value;
    if (node.key) fields[node.key] = scalarValue(node.value);
  }
  return { labeledFields, fields };
}

function findNodes(tree, predicate, acc = []) {
  for (const node of tree) {
    if (predicate(node)) acc.push(node);
    if (node.children?.length) findNodes(node.children, predicate, acc);
  }
  return acc;
}

function nodeToObject(node) {
  const out = {
    label: node.label,
    key: node.key,
    value: node.value,
  };
  if (node.children?.length) {
    out.children = node.children.map(nodeToObject);
  }
  return out;
}

function deriveTxTemplates(tree) {
  const templates = [];
  const templateSections = findNodes(tree, (node) => /^transaction templates?/i.test(node.label));
  for (const section of templateSections) {
    for (const child of section.children || []) {
      const fields = {};
      for (const grandchild of child.children || []) {
        if (grandchild.value != null && grandchild.key) fields[grandchild.key] = scalarValue(grandchild.value);
      }
      templates.push({
        label: child.label,
        ...fields,
      });
    }
  }
  if (templates.length) return templates;

  const singleTemplate = findNodes(tree, (node) => /^transaction template$/i.test(node.label));
  for (const section of singleTemplate) {
    const fields = {};
    for (const child of section.children || []) {
      if (child.value != null && child.key) fields[child.key] = scalarValue(child.value);
    }
    templates.push(fields);
  }
  return templates;
}

function deriveBlockers(text, labeledFields, tree) {
  const blockers = [];
  for (const [label, value] of Object.entries(labeledFields)) {
    if (/blocker|blocked/i.test(label) || /blocker|blocked/i.test(String(value))) {
      blockers.push({ label, value });
    }
  }
  const blockerNodes = findNodes(tree, (node) => /blocker|blocked/i.test(node.label) || /blocker|blocked/i.test(String(node.value || "")));
  for (const node of blockerNodes) {
    blockers.push({ label: node.label, value: node.value });
  }
  const textMatches = String(text || "").match(/^[^-\n]*\b(BLOCKER|BLOCKED)\b.*$/gim) || [];
  for (const value of textMatches) blockers.push({ label: "raw", value: value.trim() });
  return blockers.filter((item, idx, arr) => arr.findIndex((other) => other.label === item.label && other.value === item.value) === idx);
}

function deriveStateMachine(command, fields) {
  const currentState = [];
  let targetState = null;
  let blockingReason = null;
  let nextRecommendedCommand = null;

  const withinRange = fields.withinRange;
  const action = fields.requiredHeartbeatAction || fields.requiredAction || null;
  const stakeIntegrity = fields.stakeIntegrity || null;
  const stakeStatus = fields.canonicalStakeStatusCode || fields.statusCode || fields.stakedStatus || null;
  const executionGate = fields.executionGate || fields.oldPositionExecutionGate || null;
  const approvalRequired = fields.approvalRequired;

  if (withinRange === true) currentState.push("IN_RANGE");
  if (withinRange === false) currentState.push("OUT_OF_RANGE");
  if (stakeStatus === "STAKED_KITTENSWAP") currentState.push("STAKED_KITTENSWAP");
  if (stakeIntegrity === "FAIL") currentState.push("STAKE_REMEDIATION_REQUIRED");
  if (action === "REBALANCE_COMPOUND_RESTAKE") {
    targetState = "IN_RANGE_STAKED";
    nextRecommendedCommand = command === "heartbeat" ? "krlp plan <tokenId> <owner> --recipient <owner>" : null;
  }
  if (action === "NONE" && stakeIntegrity !== "FAIL") {
    targetState = currentState.includes("STAKED_KITTENSWAP") ? "IN_RANGE_STAKED" : "HOLD";
  }
  if (action === "STAKE_REMEDIATION_REQUIRED" || stakeIntegrity === "FAIL") {
    targetState = "STAKE_REMEDIATION_REQUIRED";
    nextRecommendedCommand = "krlp farm-status <tokenId> <owner>";
  }
  if (executionGate === "BLOCKED") {
    blockingReason = "execution_gate_blocked";
  }
  if (approvalRequired === true || approvalRequired === "YES") {
    currentState.push("APPROVAL_REQUIRED");
  }
  if (!currentState.length) {
    if (/wallet|portfolio/.test(command) && fields.positionsScanned === 0) currentState.push("NO_ACTIVE_POSITION");
    else currentState.push("UNKNOWN");
  }

  return {
    currentState,
    targetState,
    allowedTransitions: targetState ? [`${currentState.join("+")} -> ${targetState}`] : [],
    blockingReason,
    nextRecommendedCommand,
  };
}

function canonicalizeCommand(invokedCommand) {
  const normalized = String(invokedCommand || "").trim().toLowerCase();
  const command = (COMMAND_MANIFEST.commands || []).find((entry) => {
    const names = [entry.name, ...(entry.aliases || [])].map((value) => String(value).toLowerCase());
    return names.includes(normalized);
  });
  return command ? command.name : normalized || "help";
}

export function renderCommandJson({
  rawInput,
  invokedCommand,
  dispatchMode,
  strictMode,
  outputText,
  inputs = {},
} = {}) {
  const { title, tree, freeform } = parseBulletTree(outputText);
  const { labeledFields, fields } = topLevelFields(tree);
  const canonicalCommand = canonicalizeCommand(invokedCommand);
  const txTemplates = deriveTxTemplates(tree);
  const blockers = deriveBlockers(outputText, labeledFields, tree);
  const stateMachine = deriveStateMachine(canonicalCommand, fields);
  const manifestEntry = (COMMAND_MANIFEST.commands || []).find((entry) => entry.name === canonicalCommand) || null;

  return {
    schemaVersion: "krlp.command-result.v1",
    commandManifestVersion: COMMAND_MANIFEST.schemaVersion,
    defaults: defaultsSnapshot(),
    dispatch: {
      rawInput: rawInput || "",
      invokedCommand: invokedCommand || canonicalCommand,
      canonicalCommand,
      dispatchMode: dispatchMode || "deterministic",
      strictMode: Boolean(strictMode),
    },
    command: manifestEntry,
    inputs,
    result: {
      title,
      labeledFields,
      fields,
      sections: tree.map(nodeToObject),
      freeform,
      blockers,
      txTemplates,
      stateMachine,
      renderedText: outputText,
    },
  };
}

export { COMMAND_MANIFEST };
