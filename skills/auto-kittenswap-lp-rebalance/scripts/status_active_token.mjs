#!/usr/bin/env node

import { parseOwnerAndArgs, runResolvedTokenCommand } from "./krlp_active_token.mjs";

const { ownerRef, passthroughArgs } = parseOwnerAndArgs(process.argv.slice(2));
const { output } = runResolvedTokenCommand({
  command: "status",
  ownerRef,
  passthroughArgs,
  includeOwnerRef: false,
});
process.stdout.write(output);
