#!/usr/bin/env node

import process from "node:process";

import { renderCommandJson } from "../skills/auto-kittenswap-lp-rebalance/scripts/krlp_json_output.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const heartbeatOutput = `Kittenswap heartbeat plan (123)\n- owner/sender: 0xabc\n- recipient: 0xabc\n- decision: HOLD\n- rebalance evaluation: healthy\n- required heartbeat action: NONE\n- within range: YES\n- range each side: lower=51.00% | upper=49.00%\n- range ticks each side now: lower=102 | upper=98\n- configured ticks each side (half-width): lower=100 | upper=100\n- min headroom pct: +49.00%\n- canonical stake status code: STAKED_KITTENSWAP\n- staked in configured Kittenswap farm: YES\n- stake integrity: PASS\n- pending reward delta since last heartbeat: 1.2 KITTEN\n- est apr (realized from pending delta): +12.34%\n- heartbeat mode: autonomous-hold\n`;

const blockedSwapOutput = `Kittenswap swap plan\n- owner/sender: 0xabc\n- execution gate: BLOCKED\n- approval required: YES\n- blocker: allowance missing\n- transaction template:\n  - to: 0xrouter\n  - data: 0x1234\n  - value: 0\n`;

const helpOutput = `Usage: krlp \"<command>\"\nCommands:\n- health\n- contracts\n`;

const heartbeatJson = renderCommandJson({
  rawInput: "krlp heartbeat 123 --json",
  invokedCommand: "heartbeat",
  dispatchMode: "deterministic",
  strictMode: false,
  outputText: heartbeatOutput,
  inputs: { positionals: ["heartbeat", "123"] },
});
assert(heartbeatJson.schemaVersion === "krlp.command-result.v1", "heartbeat schema version mismatch");
assert(heartbeatJson.result.fields.decision === "HOLD", "heartbeat decision parse failed");
assert(heartbeatJson.result.stateMachine.targetState === "IN_RANGE_STAKED", "heartbeat target state mismatch");

const blockedSwapJson = renderCommandJson({
  rawInput: "krlp swap-plan ... --json",
  invokedCommand: "swap-plan",
  dispatchMode: "deterministic",
  strictMode: true,
  outputText: blockedSwapOutput,
  inputs: { positionals: ["swap-plan"] },
});
assert(blockedSwapJson.result.blockers.length >= 1, "blocked swap should report blockers");
assert(blockedSwapJson.result.stateMachine.blockingReason === "execution_gate_blocked", "blocked swap state machine mismatch");
assert(Array.isArray(blockedSwapJson.result.txTemplates), "swap txTemplates should be array");

const helpJson = renderCommandJson({
  rawInput: "krlp help --json",
  invokedCommand: "help",
  dispatchMode: "deterministic",
  strictMode: false,
  outputText: helpOutput,
  inputs: { positionals: ["help"] },
});
assert(helpJson.command.name === "help", "help command resolution mismatch");

process.stdout.write("JSON contract scenarios passed.\n");
