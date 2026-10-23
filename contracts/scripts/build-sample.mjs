// Builds the compliant SAMPLE contract: the real root (openapi/shri-health.yaml) plus the sample paths and schemas in
// tests/lint-fixtures/valid/sample-module.yaml, bundled to tests/.tmp/sample.bundled.yaml.
// Used by the lint-fixture check and by `npm run mock:sample` (Prism needs at least one operation, and the real
// contract has none until Stage 4).
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SAMPLE_BUNDLE = join(ROOT, 'tests', '.tmp', 'sample.bundled.yaml');

export function buildSample() {
  const tmp = join(ROOT, 'tests', '.tmp');
  mkdirSync(tmp, { recursive: true });
  const root = YAML.parse(readFileSync(join(ROOT, 'openapi', 'shri-health.yaml'), 'utf8'));
  const sample = YAML.parse(readFileSync(join(ROOT, 'tests', 'lint-fixtures', 'valid', 'sample-module.yaml'), 'utf8'));
  root.info.title = 'Shri Health API — compliant SAMPLE (not the contract)';
  root.paths = sample.paths;
  root.components.schemas = { ...root.components.schemas, ...sample.components.schemas };
  const text = YAML.stringify(root, { lineWidth: 0 }).replace(/(\$ref: )["']?components\//g, '$1../../openapi/components/');
  writeFileSync(join(tmp, 'sample.yaml'), text);
  const b = spawnSync(join(ROOT, 'node_modules', '.bin', 'redocly'), ['bundle', join(tmp, 'sample.yaml'), '--output', SAMPLE_BUNDLE], { encoding: 'utf8', env: { ...process.env, REDOCLY_TELEMETRY: 'off', REDOCLY_SUPPRESS_UPDATE_NOTICE: 'true' } });
  if (b.status !== 0) throw new Error(`Bundling the sample failed: ${b.stderr || b.stdout}`);
  return SAMPLE_BUNDLE;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(`Sample bundle: ${buildSample()}`);
