import { readFileSync } from "node:fs";

import { normalizeAddress } from "./kittenswap_rebalance_api.mjs";

const ROUTING_URL = new URL("../references/kittenswap-routing-metadata.json", import.meta.url);

const ROUTING_METADATA = Object.freeze(JSON.parse(readFileSync(ROUTING_URL, "utf8")));

function addressInGroup(address, groupName) {
  const list = ROUTING_METADATA.tokenGroups?.[groupName] || [];
  const normalized = normalizeAddress(address || "");
  return Boolean(normalized && list.some((candidate) => normalizeAddress(candidate) === normalized));
}

function findGroup(address) {
  for (const groupName of Object.keys(ROUTING_METADATA.tokenGroups || {})) {
    if (addressInGroup(address, groupName)) return groupName;
  }
  return null;
}

export function getRoutingMetadataForPair(tokenIn, tokenOut) {
  const inGroup = findGroup(tokenIn);
  const outGroup = findGroup(tokenOut);
  if (!inGroup || !outGroup) return null;
  const want = [inGroup, outGroup].sort().join("|");
  const match = (ROUTING_METADATA.rules || []).find((rule) => {
    const pair = [...(rule.pair || [])].sort().join("|");
    return pair === want;
  });
  return match ? { ...match, tokenInGroup: inGroup, tokenOutGroup: outGroup } : null;
}

export function buildRoutingNotes({ tokenIn, tokenOut, tokenInSymbol = "tokenIn", tokenOutSymbol = "tokenOut", quoteFeeTier = null } = {}) {
  const route = getRoutingMetadataForPair(tokenIn, tokenOut);
  if (!route) return [];

  const lines = [];
  const pairLabel = `${tokenInSymbol}/${tokenOutSymbol}`;
  if (route.tokenInGroup === "kitten" || route.tokenOutGroup === "kitten") {
    lines.push("- KITTEN routing policy is loaded from machine-readable metadata.");
  }

  if (route.preferredRoute?.kind === "singleHop") {
    lines.push(`- preferred route for ${pairLabel}: single-hop direct pool.`);
  } else if (route.preferredRoute?.kind === "multiHop") {
    const via = Array.isArray(route.preferredRoute?.via) && route.preferredRoute.via.length
      ? route.preferredRoute.via.join(" -> ")
      : "intermediate route";
    lines.push(`- preferred route for ${pairLabel}: multi-hop via ${via}.`);
  }

  lines.push(`- supports single-hop execution: ${route.supportsSingleHop ? "YES" : "NO"}`);
  lines.push(`- approval target: ${ROUTING_METADATA.approvalTarget}`);

  if (quoteFeeTier != null) {
    lines.push(`- route quote fee tier (raw): ${quoteFeeTier}`);
  }

  for (const risk of route.knownExecutionRisks || []) {
    if (risk === "directOneHopMayRevert") {
      lines.push("- note: direct one-hop execution can revert on thin pools; prefer the declared route.");
    } else if (risk === "thinLiquidity") {
      lines.push("- note: thin liquidity is expected on this route family; re-quote immediately before signing.");
    } else if (risk === "effectiveExecutionCostCanBeHigh") {
      lines.push("- pricing expectation: effective execution cost can be high; values up to ~5% are not by themselves a contract bug.");
    } else {
      lines.push(`- known execution risk: ${risk}`);
    }
  }

  return lines;
}

export { ROUTING_METADATA };
