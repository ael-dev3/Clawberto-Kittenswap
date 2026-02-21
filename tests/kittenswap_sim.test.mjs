import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  readPosition,
  readPoolAddressByPair,
  readPoolGlobalState,
  readPoolTickSpacing,
  readPositionManagerFarmingCenter,
  readPositionFarmingApproval,
  readTokenFarmedIn,
  readEternalFarmingIncentiveKey,
  readFarmingCenterDeposit,
  readEternalFarmingRewardBalance,
  buildApproveForFarmingCalldata,
  buildFarmingEnterCalldata,
  buildFarmingCollectRewardsCalldata,
  buildFarmingClaimRewardCalldata,
} from "../skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_api.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const CHAT_SCRIPT = path.join(ROOT, "skills/auto-kittenswap-lp-rebalance/scripts/kittenswap_rebalance_chat.mjs");

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const ADDR = {
  FACTORY: "0x5f95e92c338e6453111fc55ee66d4aafcce661a7",
  POSITION_MANAGER: "0x9ea4459c8defbf561495d95414b9cf1e2242a3e2",
  FARMING_CENTER: "0x211bd8917d433b7cc1f4497aba906554ab6ee479",
  ETERNAL_FARMING: "0xf3b57fe4d5d0927c3a5e549cb6af1866687e2d62",
  POOL: "0x12df9913e9e08453440e3c4b1ae73819160b513e",
  WHYPE: "0x5555555555555555555555555555555555555555",
  USDC: "0xb88339cb7199b77e23db6e890353e22632ba630f",
  KITTEN: "0x618275f8efe54c2afa87bfb9f210a52f0ff89364",
};

const SEL = {
  positions: "0x99fbab88",
  poolByPair: "0xd9a641e1",
  globalState: "0xe76c01e4",
  tickSpacing: "0xd0c93a7c",
  farmingCenter: "0xdd56e5d8",
  farmingApprovals: "0x2d0b22de",
  tokenFarmedIn: "0xe7ce18a3",
  incentiveKeys: "0x57655846",
  deposits: "0xb02c43d0",
  rewards: "0xe70b9e27",
};

function pad64(hexNoPrefix) {
  return hexNoPrefix.padStart(64, "0");
}

function encodeUint(value) {
  return pad64(BigInt(value).toString(16));
}

function encodeInt(value) {
  const v = BigInt(value);
  const x = v < 0n ? (1n << 256n) + v : v;
  return pad64(x.toString(16));
}

function encodeAddress(address) {
  return pad64(String(address).toLowerCase().replace(/^0x/, ""));
}

function encodeBool(value) {
  return encodeUint(value ? 1n : 0n);
}

function encodeWords(words) {
  return `0x${words.join("")}`;
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

let rpcServer = null;
let rpcUrl = "";

function handleEthCall({ to, data }) {
  const target = String(to || "").toLowerCase();
  const input = String(data || "0x").toLowerCase();
  const sel = input.slice(0, 10);

  if (target === ADDR.POSITION_MANAGER && sel === SEL.positions) {
    return encodeWords([
      encodeUint(0n),
      encodeAddress(ZERO_ADDRESS),
      encodeAddress(ADDR.WHYPE),
      encodeAddress(ADDR.USDC),
      encodeAddress(ZERO_ADDRESS),
      encodeInt(-242570),
      encodeInt(-242070),
      encodeUint(1000n),
      encodeUint(0n),
      encodeUint(0n),
      encodeUint(0n),
      encodeUint(0n),
    ]);
  }

  if (target === ADDR.FACTORY && sel === SEL.poolByPair) {
    return encodeWords([encodeAddress(ADDR.POOL)]);
  }

  if (target === ADDR.POOL && sel === SEL.globalState) {
    return encodeWords([
      encodeUint(1n << 96n),
      encodeInt(-242319),
      encodeUint(3000n),
      encodeUint(0n),
      encodeUint(0n),
      encodeBool(true),
    ]);
  }

  if (target === ADDR.POOL && sel === SEL.tickSpacing) {
    return encodeWords([encodeInt(10)]);
  }

  if (target === ADDR.POSITION_MANAGER && sel === SEL.farmingCenter) {
    return encodeWords([encodeAddress(ADDR.FARMING_CENTER)]);
  }

  if (target === ADDR.POSITION_MANAGER && sel === SEL.farmingApprovals) {
    return encodeWords([encodeAddress(ADDR.FARMING_CENTER)]);
  }

  if (target === ADDR.POSITION_MANAGER && sel === SEL.tokenFarmedIn) {
    return encodeWords([encodeAddress(ZERO_ADDRESS)]);
  }

  if (target === ADDR.ETERNAL_FARMING && sel === SEL.incentiveKeys) {
    return encodeWords([
      encodeAddress(ADDR.KITTEN),
      encodeAddress(ADDR.WHYPE),
      encodeAddress(ADDR.POOL),
      encodeUint(1n),
    ]);
  }

  if (target === ADDR.FARMING_CENTER && sel === SEL.deposits) {
    return encodeWords([encodeUint(0n)]);
  }

  if (target === ADDR.ETERNAL_FARMING && sel === SEL.rewards) {
    return encodeWords([encodeUint(123_000_000_000_000_000n)]);
  }

  throw new Error(`Unhandled eth_call: to=${target} selector=${sel}`);
}

before(async () => {
  rpcServer = http.createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Connection", "close");
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      const payload = JSON.parse(body || "{}");
      const { id = 1, method, params = [] } = payload;

      if (method === "eth_call") {
        const tx = params[0] || {};
        res.end(JSON.stringify(rpcResult(id, handleEthCall(tx))));
        return;
      }

      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Unsupported method ${method}` },
      }));
    } catch (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(error) }));
    }
  });

  await new Promise((resolve) => rpcServer.listen(0, "127.0.0.1", resolve));
  const addr = rpcServer.address();
  rpcUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  if (!rpcServer) return;
  await new Promise((resolve) => rpcServer.close(resolve));
});

test("mock rpc sim decodes position, pool, and farming state", async () => {
  const tokenId = 123n;
  const pos = await readPosition(tokenId, { positionManager: ADDR.POSITION_MANAGER, rpcUrl });
  assert.equal(pos.token0, ADDR.WHYPE);
  assert.equal(pos.token1, ADDR.USDC);
  assert.equal(pos.tickLower, -242570);
  assert.equal(pos.tickUpper, -242070);

  const pool = await readPoolAddressByPair(ADDR.WHYPE, ADDR.USDC, { factory: ADDR.FACTORY, rpcUrl });
  assert.equal(pool, ADDR.POOL);

  const state = await readPoolGlobalState(ADDR.POOL, { rpcUrl });
  assert.equal(state.tick, -242319);
  assert.equal(state.unlocked, true);

  const spacing = await readPoolTickSpacing(ADDR.POOL, { rpcUrl });
  assert.equal(spacing, 10);

  const farmingCenter = await readPositionManagerFarmingCenter({ positionManager: ADDR.POSITION_MANAGER, rpcUrl });
  assert.equal(farmingCenter, ADDR.FARMING_CENTER);

  const farmingApproval = await readPositionFarmingApproval(tokenId, { positionManager: ADDR.POSITION_MANAGER, rpcUrl });
  assert.equal(farmingApproval, ADDR.FARMING_CENTER);

  const tokenFarmedIn = await readTokenFarmedIn(tokenId, { positionManager: ADDR.POSITION_MANAGER, rpcUrl });
  assert.equal(tokenFarmedIn, ZERO_ADDRESS);

  const key = await readEternalFarmingIncentiveKey(ADDR.POOL, { eternalFarming: ADDR.ETERNAL_FARMING, rpcUrl });
  assert.equal(key.rewardToken, ADDR.KITTEN);
  assert.equal(key.bonusRewardToken, ADDR.WHYPE);
  assert.equal(key.pool, ADDR.POOL);
  assert.equal(key.nonce, 1n);

  const deposit = await readFarmingCenterDeposit(tokenId, { farmingCenter: ADDR.FARMING_CENTER, rpcUrl });
  assert.equal(deposit, `0x${"0".repeat(64)}`);

  const rewards = await readEternalFarmingRewardBalance("0x1111111111111111111111111111111111111111", ADDR.KITTEN, {
    eternalFarming: ADDR.ETERNAL_FARMING,
    rpcUrl,
  });
  assert.equal(rewards, 123_000_000_000_000_000n);
});

test("farming calldata builders stay deterministic", () => {
  const tokenId = 123n;
  const key = {
    rewardToken: ADDR.KITTEN,
    bonusRewardToken: ADDR.WHYPE,
    pool: ADDR.POOL,
    nonce: 1n,
  };

  const approveData = buildApproveForFarmingCalldata({
    tokenId,
    approve: true,
    farmingAddress: ADDR.FARMING_CENTER,
  });
  assert.match(approveData, /^0x832f630a/);

  const enterData = buildFarmingEnterCalldata({ ...key, tokenId });
  assert.match(enterData, /^0x5739f0b9/);

  const collectData = buildFarmingCollectRewardsCalldata({ ...key, tokenId });
  assert.match(collectData, /^0x6af00aee/);

  const claimData = buildFarmingClaimRewardCalldata({
    rewardToken: ADDR.KITTEN,
    to: "0x1111111111111111111111111111111111111111",
    amountRequested: (1n << 128n) - 1n,
  });
  assert.match(claimData, /^0x2f2d783d/);
});

test("chat source includes burn opt-in and mint deadline guard rails", () => {
  const source = fs.readFileSync(CHAT_SCRIPT, "utf8");

  assert.match(source, /const deadlineIso = new Date\(\(nowTs \+ effDeadlineSec\) \* 1000\)\.toISOString\(\);/);
  assert.match(source, /const deadlineHeadroomSec = effDeadlineSec;/);

  assert.match(source, /const includeBurnStep = parseBoolFlag\(allowBurn\);/);
  assert.match(source, /if \(includeBurnStep\) \{\s*calls\.push\(\{ step: "burn_old_nft"/);
  assert.match(source, /burn old nft step included: \$\{includeBurnStep \? "YES \(\-\-allow-burn\)" : "NO \(default safety\)"\}/);

  assert.match(source, /farm-status <tokenId>/);
  assert.match(source, /farm-enter-plan <tokenId>/);
  assert.match(source, /farm-claim-plan <rewardToken>/);
});

