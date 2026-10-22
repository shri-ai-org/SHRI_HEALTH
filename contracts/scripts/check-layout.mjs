// Checks the contract layout (TOOLCHAIN §3): one module file per tag, each with `paths` and `components.schemas`,
// no stray module files, and no /ready path (internal only, not in the contract).
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const OPENAPI = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'openapi');
const root = YAML.parse(readFileSync(join(OPENAPI, 'shri-health.yaml'), 'utf8'));
const problems = [];
// partner-callbacks paths live in platform.yaml (both are Thulasi's).
const expected = new Set((root.tags || []).map((t) => t.name).filter((n) => n !== 'partner-callbacks'));
const files = new Set(readdirSync(join(OPENAPI, 'modules')).filter((f) => f.endsWith('.yaml')).map((f) => f.replace(/\.yaml$/, '')));
for (const t of expected) if (!files.has(t)) problems.push(`Tag "${t}" has no module file modules/${t}.yaml`);
for (const f of files) {
  if (!expected.has(f)) problems.push(`modules/${f}.yaml has no matching tag in shri-health.yaml`);
  const m = YAML.parse(readFileSync(join(OPENAPI, 'modules', `${f}.yaml`), 'utf8')) || {};
  if (typeof m.paths !== 'object' || m.paths === null) problems.push(`modules/${f}.yaml must have a "paths" object`);
  if (!m.components || typeof m.components.schemas !== 'object') problems.push(`modules/${f}.yaml must have "components.schemas"`);
}
for (const t of root.tags || []) if (!['vimal', 'thulasi', 'anand', 'minalini'].includes(t['x-owner'])) problems.push(`Tag "${t.name}" needs x-owner`);
if (root.paths && root.paths['/ready']) problems.push('/ready is internal and must not be in the contract');
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log(`Layout OK: ${files.size} module files, ${(root.tags || []).length} tags.`);
