#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
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
const strictAgentScript = path.join(
  repoRoot,
  'skills',
  'auto-kittenswap-lp-rebalance',
  'scripts',
  'krlp_agent.mjs',
);
const commandManifestPath = path.join(
  repoRoot,
  'skills',
  'auto-kittenswap-lp-rebalance',
  'commands.manifest.json',
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
  for (const marker of ['## Agent Contract Surface', '## Validation', '### CI-safe / repo-safe validation', '### Live runtime / operator validation', 'npm run check']) {
    assert(readme.includes(marker), `README missing validation marker: ${marker}`);
  }
  console.log('PASS README documents agent contract surfaces and validation split');

  const staleHeartbeatExamples = [
    ['skills/auto-kittenswap-lp-rebalance/references/openclaw-instance-porting.md', /heartbeat_contract_smoke\.sh <owner\|label> <owner\|label> 500/],
    ['skills/auto-kittenswap-lp-rebalance/references/openclaw-instance-porting.md', /kittenswap_guardrail_audit\.sh <owner\|label> <owner\|label> 500/],
    ['skills/auto-kittenswap-lp-rebalance/references/rebalance-playbook.md', /heartbeat_contract_smoke\.sh <ownerLabel> <recipientLabel> 500/],
    ['skills/auto-kittenswap-lp-rebalance/references/rebalance-playbook.md', /kittenswap_guardrail_audit\.sh <ownerLabel> <recipientLabel> 500/],
  ];
  for (const [relPath, pattern] of staleHeartbeatExamples) {
    const text = readFileSync(path.join(repoRoot, relPath), 'utf8');
    assert(!pattern.test(text), `Stale heartbeat example still present in ${relPath}`);
  }
  console.log('PASS reference docs do not contain stale 500 bps heartbeat examples');

  const commandManifest = JSON.parse(readFileSync(commandManifestPath, 'utf8'));
  assert(commandManifest.strictEntrypoint, 'commands.manifest.json missing strictEntrypoint');
  assert(commandManifest.defaultsFile, 'commands.manifest.json missing defaultsFile');
  assert(commandManifest.commandSurfaceOwner, 'commands.manifest.json missing commandSurfaceOwner');
  for (const relPath of [commandManifest.strictEntrypoint, commandManifest.defaultsFile, commandManifest.commandSurfaceOwner]) {
    const full = path.resolve(path.dirname(commandManifestPath), relPath);
    assert(allFiles.includes(full), `commands.manifest.json references missing file: ${relPath}`);
  }
  console.log('PASS commands.manifest.json canonical file references');

  run('node', ['scripts/sync_defaults_docs.mjs']);
  console.log('PASS defaults docs sync check');

  run('node', ['scripts/json_contract_scenarios.mjs']);
  console.log('PASS JSON contract scenarios');

  run('node', ['scripts/pool_registry_scenarios.mjs']);
  console.log('PASS pool registry scenarios');

  const helpJsonRaw = run('node', [cliScript, 'krlp help --json --strict']);
  const helpJson = JSON.parse(helpJsonRaw);
  assert(helpJson.schemaVersion === 'krlp.command-result.v1', 'CLI --json schemaVersion mismatch');
  assert(helpJson.dispatch?.strictMode === true, 'CLI --json strictMode mismatch');
  assert(helpJson.command?.name === 'help', 'CLI --json command resolution mismatch');
  console.log('PASS CLI --json --strict help contract');

  const strictAgent = spawnSync('node', [strictAgentScript], {
    cwd: repoRoot,
    encoding: 'utf8',
    input: JSON.stringify({ command: 'help' }),
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 180000,
    maxBuffer: 12_000_000,
  });
  if (strictAgent.error) throw strictAgent.error;
  assert(strictAgent.status === 0, `krlp_agent strict JSON smoke failed: ${strictAgent.stderr || strictAgent.stdout}`);
  const strictJson = JSON.parse(strictAgent.stdout);
  assert(strictJson.schemaVersion === 'krlp.command-result.v1', 'krlp_agent schemaVersion mismatch');
  assert(strictJson.dispatch?.strictMode === true, 'krlp_agent strictMode mismatch');
  assert(strictJson.command?.name === 'help', 'krlp_agent command resolution mismatch');
  console.log('PASS krlp_agent strict JSON help contract');
}

if (runSmoke) {
  logSection('static CLI smoke');

  const helpOutput = run('node', [cliScript, 'krlp help']);
  for (const needle of ['Usage: krlp "<command>"', 'Commands:', 'health', 'contracts', 'pool-resolve|resolve-pool', 'enter-plan|lp-enter-plan', 'heartbeat|heartbeat-plan']) {
    assert(helpOutput.includes(needle), `krlp help missing expected text: ${needle}`);
  }
  console.log('PASS krlp help');

  const contractsOutput = run('node', [cliScript, 'krlp contracts']);
  for (const needle of ['Kittenswap contracts (HyperEVM mainnet)', '- factory:', '- router:', '- positionManager:', '- USDC: 0xb88339cb7199b77e23db6e890353e22632ba630f', '- full token/pair CA inventory:']) {
    assert(contractsOutput.includes(needle), `krlp contracts missing expected text: ${needle}`);
  }
  console.log('PASS krlp contracts');
}

console.log('\nAll Kittenswap repo checks passed.');
