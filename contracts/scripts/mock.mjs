// Starts the Prism mock server on the bundled contract (port 4010). Prism needs at least one operation; until Stage 4
// adds endpoints, this explains that and points to `npm run mock:sample`.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const file = process.argv[2] || join(ROOT, 'openapi', 'dist', 'shri-health.bundled.yaml');
const doc = YAML.parse(readFileSync(file, 'utf8'));
const ops = Object.values(doc.paths || {}).flatMap((item) => Object.keys(item || {}).filter((k) => ['get', 'put', 'post', 'patch', 'delete'].includes(k)));
if (ops.length === 0) {
  console.error('The contract has no operations yet (Stage 3 = shared components only), and Prism needs at least one.');
  console.error('Use `npm run mock:sample` to mock the compliant sample that uses the shared components.');
  process.exit(2);
}
spawn(join(ROOT, 'node_modules', '.bin', 'prism'), ['mock', file, '--port', process.env.PORT || '4010'], { stdio: 'inherit' })
  .on('exit', (code) => process.exit(code ?? 0));
