// Example expiry dates stay in the future (#39): every timestamp in a field named like an expiry (`expiresAt`,
// `idleExpiresAt`, `expiry…`, `validUntil`) must be at least a year ahead, in every example, `example` and default of
// the contract. A past one makes the screens treat a session, link or code from the sample-data server as expired.
//
//   node --test tests/example-dates.test.mjs     (part of npm test)
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const OPENAPI = resolve(dirname(fileURLToPath(import.meta.url)), '../openapi');
const EXPIRY_KEY = /(^|[a-z])[eE]xpires?(At|On)?$|^expiry|ExpiryAt$|^validUntil$/;
const STAMP = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/;
const YEAR = 365 * 24 * 60 * 60 * 1000;

/** Every expiry-named timestamp in a parsed document that is less than a year after `now`, as `path: value`. */
export function expiringSoon(document, now = Date.now()) {
  const found = [];
  const check = (value, path) => {
    if (typeof value === 'string' && STAMP.test(value) && Date.parse(value) < now + YEAR) found.push(`${path}: ${value}`);
  };
  const walk = (node, path) => {
    if (Array.isArray(node)) return node.forEach((item, i) => walk(item, `${path}/${i}`));
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      const here = `${path}/${key}`;
      if (EXPIRY_KEY.test(key)) {
        check(value, here); // an example value
        if (value && typeof value === 'object') {
          // a schema property: its own example, examples and default
          check(value.example, `${here}/example`);
          check(value.default, `${here}/default`);
          if (Array.isArray(value.examples)) value.examples.forEach((v, i) => check(v, `${here}/examples/${i}`));
        }
      }
      walk(value, here);
    }
  };
  walk(document, '');
  return found;
}

function contractFiles(folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap((e) => {
    if (e.isSymbolicLink() || e.name === 'dist') return [];
    const path = join(folder, e.name);
    if (e.isDirectory()) return contractFiles(path);
    return e.name.endsWith('.yaml') ? [path] : [];
  });
}

test('the check finds a past or near expiry, and ignores other fields', () => {
  const now = Date.parse('2026-10-27T00:00:00Z');
  const doc = {
    paths: { '/x': { get: { responses: { 200: { content: { 'application/json': { examples: {
      past: { value: { idleExpiresAt: '2026-10-26T16:15:00Z', expiresAt: '2035-01-01T20:00:00Z', createdAt: '2020-01-01T00:00:00Z' } },
      soon: { value: { link: { expiresAt: '2027-03-01T00:00:00Z' } } },
    } } } } } } } },
    components: { schemas: { Grant: { properties: {
      expiresAt: { type: 'string', format: 'date-time', example: '2026-11-04T02:00:00Z' },
      validUntil: { type: 'string', examples: ['2035-01-01T00:00:00Z'] },
    } } } },
  };
  assert.deepEqual(expiringSoon(doc, now).map((f) => f.split(': ')[0]), [
    '/paths//x/get/responses/200/content/application/json/examples/past/value/idleExpiresAt',
    '/paths//x/get/responses/200/content/application/json/examples/soon/value/link/expiresAt',
    '/components/schemas/Grant/properties/expiresAt/example',
  ]);
});

test('every expiry in the contract is at least a year in the future', () => {
  const files = contractFiles(OPENAPI);
  assert.ok(files.length > 10, `expected the contract files under ${OPENAPI}, found ${files.length}`);
  const found = files.flatMap((file) => expiringSoon(YAML.parse(readFileSync(file, 'utf8')))
    .map((f) => `${relative(OPENAPI, file)}${f}`));
  assert.deepEqual(found, [], `Move these to 2035 or later (keep the gaps between times):\n${found.join('\n')}`);
});
