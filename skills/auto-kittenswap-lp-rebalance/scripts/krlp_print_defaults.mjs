#!/usr/bin/env node

import { defaultsSnapshot } from "./krlp_defaults.mjs";

const pathRef = process.argv[2] || "";
const snapshot = defaultsSnapshot();
if (!pathRef) {
  process.stdout.write(JSON.stringify(snapshot, null, 2) + "\n");
  process.exit(0);
}

const value = pathRef.split(".").reduce((acc, part) => (acc == null ? undefined : acc[part]), snapshot);
if (value === undefined) {
  console.error(`Unknown defaults path: ${pathRef}`);
  process.exit(1);
}
if (typeof value === "object") {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
} else {
  process.stdout.write(`${value}\n`);
}
