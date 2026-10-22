// Proves every shri- lint rule catches what it claims (CONTRACT_GOVERNANCE §5).
//
// 1. Coverage: every shri- rule in openapi/.spectral.yaml has a fixture tests/lint-fixtures/<rule>.yaml, and vice versa.
// 2. Each fixture fails on its own rule: the rule runs alone (all other rules switched off) and must report it.
// 3. A compliant sample module (lint-fixtures/valid/sample-module.yaml), added to a copy of the real root
//    contract and bundled, passes the full ruleset with no errors, so the rules do not fire on correct input.
//
// Run from contracts/: npm run lint:fixtures
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSample } from '../scripts/build-sample.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'node_modules', '.bin');
const RULESET = join(ROOT, 'openapi', '.spectral.yaml');
const FIXTURES = join(ROOT, 'tests', 'lint-fixtures');
const TMP = join(ROOT, 'tests', '.tmp');

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

function spectral(file, ruleset) {
  const out = join(TMP, 'result.json');
  rmSync(out, { force: true });
  const r = spawnSync(join(BIN, 'spectral'), ['lint', file, '--ruleset', ruleset, '--format', 'json', '--output', out, '--fail-severity', 'error'], { encoding: 'utf8' });
  let results = [];
  try { results = JSON.parse(readFileSync(out, 'utf8')); } catch { /* no output file */ }
  if (r.status !== 0 && r.status !== 1) throw new Error(`Spectral failed on ${file}: ${r.stderr || r.stdout}`);
  if (r.status === 1 && results.length === 0) throw new Error(`Spectral error on ${file}: ${r.stderr || r.stdout}`);
  return results;
}

const rulesetText = readFileSync(RULESET, 'utf8');
const rules = [...rulesetText.matchAll(/^ {2}(shri-[a-z-]+):\s*$/gm)].map((m) => m[1]);
const fixtures = readdirSync(FIXTURES).filter((f) => f.endsWith('.yaml')).map((f) => f.replace(/\.yaml$/, ''));

let failed = 0;
const rows = [];

for (const r of rules) if (!fixtures.includes(r)) { rows.push([r, 'MISSING FIXTURE', '']); failed++; }
for (const f of fixtures) if (!rules.includes(f)) { rows.push([f, 'FIXTURE WITHOUT RULE', '']); failed++; }

for (const rule of rules.filter((r) => fixtures.includes(r))) {
  const iso = join(TMP, `iso-${rule}.yaml`);
  writeFileSync(iso, `extends: [["${RULESET.replace(/\\/g, '/')}", off]]\nrules:\n  ${rule}: true\n`);
  const results = spectral(join(FIXTURES, `${rule}.yaml`), iso);
  const hits = results.filter((x) => x.code === rule);
  if (hits.length) rows.push([rule, 'fails as expected', `${hits.length} finding(s): ${hits[0].message.slice(0, 90)}`]);
  else { rows.push([rule, 'DID NOT FIRE', results.map((x) => x.code).join(', ')]); failed++; }
}

// Compliant sample: real root + sample paths and schemas, bundled, full ruleset.
const sampleBundle = buildSample();
const sampleResults = spectral(sampleBundle, RULESET);
const errors = sampleResults.filter((x) => x.severity === 0);
const warnings = sampleResults.filter((x) => x.severity === 1);
if (errors.length) {
  failed++;
  rows.push(['valid sample', `${errors.length} ERROR(S)`, errors.slice(0, 5).map((x) => `${x.code} @ ${x.path.join('.')}`).join('; ')]);
} else rows.push(['valid sample', 'passes full ruleset', `0 errors, ${warnings.length} warning(s)${warnings.length ? ': ' + [...new Set(warnings.map((x) => x.code))].join(', ') : ''}`]);

const w = Math.max(...rows.map((r) => r[0].length));
for (const [a, b2, c] of rows) console.log(`${a.padEnd(w)}  ${b2.padEnd(20)}  ${c}`);
console.log(`\n${rules.length} shri- rules, ${fixtures.length} fixtures, ${failed ? failed + ' FAILURE(S)' : 'all checks passed'}`);
process.exit(failed ? 1 : 0);
