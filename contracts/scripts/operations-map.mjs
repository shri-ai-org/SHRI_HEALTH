// Writes openapi/dist/operations.json from the bundled contract: each operation's method, full path,
// x-permission, x-audit and x-idempotency. Core reads it at runtime (backend/app/core/operations.py,
// #79): the startup check of every route against its operation, and the audit rows. The API image
// copies in this one file and never the contract (backend/Dockerfile, named build context).
//
//   node scripts/operations-map.mjs           # write it (npm run bundle does this after bundling)
//   node scripts/operations-map.mjs --check   # exit 1 if it is missing or differs from the bundle
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = resolve(ROOT, 'openapi/dist/shri-health.bundled.yaml');
const OUT = resolve(ROOT, 'openapi/dist/operations.json');
const API_PREFIX = '/api/v1';
const METHODS = ['get', 'put', 'post', 'patch', 'delete'];

// Keys sorted at every level, so the file only changes when an operation does.
const sorted = (value) => {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
  }
  return value;
};

export function buildMap(bundle) {
  const operations = {};
  for (const [path, item] of Object.entries(bundle.paths)) {
    // A path item that overrides `servers` with "/" lives outside /api/v1 (/health, /hooks).
    const atRoot = (item.servers ?? []).some((server) => server.url === '/');
    for (const method of METHODS) {
      const operation = item[method];
      if (!operation) continue;
      const id = operation.operationId;
      if (id in operations) throw new Error(`operationId ${id} is used twice`);
      if (!operation['x-permission'] || !operation['x-audit']) {
        throw new Error(`${id} has no x-permission or x-audit`);
      }
      operations[id] = {
        method: method.toUpperCase(),
        path: atRoot ? path : `${API_PREFIX}${path}`,
        permission: operation['x-permission'],
        audit: operation['x-audit'],
        idempotency: operation['x-idempotency'] ?? null,
      };
    }
  }
  return {
    source: 'contracts/openapi/dist/shri-health.bundled.yaml',
    generatedBy: 'npm run bundle (scripts/operations-map.mjs)',
    operations,
  };
}

export const render = (map) => `${JSON.stringify(sorted(map), null, 1)}\n`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // The bundle repeats shared parts as anchors and aliases; read them all.
  const bundle = YAML.parse(readFileSync(BUNDLE, 'utf8'), { maxAliasCount: -1 });
  const rendered = render(buildMap(bundle));
  if (process.argv.includes('--check')) {
    if (!existsSync(OUT) || readFileSync(OUT, 'utf8') !== rendered) {
      console.error('openapi/dist/operations.json is stale: run `npm run bundle` in contracts/ and commit it');
      process.exit(1);
    }
    console.log('openapi/dist/operations.json matches the bundle');
  } else {
    writeFileSync(OUT, rendered);
    console.log(`wrote openapi/dist/operations.json (${Object.keys(JSON.parse(rendered).operations).length} operations)`);
  }
}
