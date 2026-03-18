#!/usr/bin/env node

import { parseOwnerAndArgs, runResolvedTokenCommand } from "./krlp_active_token.mjs";

const { ownerRef, passthroughArgs } = parseOwnerAndArgs(process.argv.slice(2));
const { output } = runResolvedTokenCommand({
  command: "farm-status",
  ownerRef,
  passthroughArgs,
  includeOwnerRef: Boolean(ownerRef),
});
process.stdout.write(output);
