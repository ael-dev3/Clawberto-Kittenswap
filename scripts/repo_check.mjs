#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const cliScript = path.join(
  repoRoot,
  'skills',
  'auto-kittenswap-lp-rebalance',
  'scripts',
  'kittenswap_rebalance_chat.mjs',
);

const args = new Set(process.argv.slice(2));
const runSyntax = !args.has('--smoke-only');
const runSmoke = !args.has('--syntax-only');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function rel(file) {
  return path.relative(repoRoot, file).replaceAll(path.sep, '/');
}

function run(cmd, cmdArgs, { cwd = repoRoot } = {}) {
  return execFileSync(cmd, cmdArgs, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function logSection(title) {
  console.log(`\n## ${title}`);
}

const allFiles = walk(repoRoot);
const mjsFiles = allFiles.filter((file) => file.endsWith('.mjs'));
const shellFiles = allFiles.filter((file) => file.endsWith('.sh'));
const jsonFiles = allFiles.filter((file) => file.endsWith('.json'));

if (runSyntax) {
  logSection('syntax + artifact checks');

  for (const file of mjsFiles) {
    run('node', ['--check', file]);
    console.log(`PASS node --check ${rel(file)}`);
  }

  for (const file of shellFiles) {
    run('bash', ['-n', file]);
    console.log(`PASS bash -n ${rel(file)}`);
  }

  for (const file of jsonFiles) {
    JSON.parse(readFileSync(file, 'utf8'));
    console.log(`PASS json parse ${rel(file)}`);
  }

  const gitignore = readFileSync(path.join(repoRoot, '.gitignore'), 'utf8');
  assert(
    gitignore.includes('skills/auto-kittenswap-lp-rebalance/state/'),
    'Expected .gitignore to ignore skills/auto-kittenswap-lp-rebalance/state/',
  );
  console.log('PASS .gitignore ignores runtime state directory');

  const trackedState = run('git', ['ls-files', 'skills/auto-kittenswap-lp-rebalance/state']).trim();
  assert(!trackedState, 'Runtime state directory has tracked files');
  console.log('PASS runtime state directory has no tracked files');

  const readme = readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  for (const marker of ['## Validation', '### CI-safe / repo-safe validation', '### Live runtime / operator validation', 'npm run check']) {
    assert(readme.includes(marker), `README missing validation marker: ${marker}`);
  }
  console.log('PASS README documents CI-safe and live-runtime validation split');

  run('node', ['scripts/sync_defaults_docs.mjs']);
  console.log('PASS defaults docs sync check');

  run('node', ['scripts/json_contract_scenarios.mjs']);
  console.log('PASS JSON contract scenarios');
}

if (runSmoke) {
  logSection('static CLI smoke');

  const helpOutput = run('node', [cliScript, 'krlp help']);
  for (const needle of ['Usage: krlp "<command>"', 'Commands:', 'health', 'contracts', 'heartbeat|heartbeat-plan']) {
    assert(helpOutput.includes(needle), `krlp help missing expected text: ${needle}`);
  }
  console.log('PASS krlp help');

  const contractsOutput = run('node', [cliScript, 'krlp contracts']);
  for (const needle of ['Kittenswap contracts (HyperEVM mainnet)', '- factory:', '- router:', '- positionManager:', '- full token/pair CA inventory:']) {
    assert(contractsOutput.includes(needle), `krlp contracts missing expected text: ${needle}`);
  }
  console.log('PASS krlp contracts');
}

console.log('\nAll Kittenswap repo checks passed.');
