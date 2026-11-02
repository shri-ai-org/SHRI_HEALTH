// The credentials-in-URL rule (owasp:api2:2023-no-credentials-in-url, redefined in openapi/rules/noCredentialsInUrl.js)
// keeps its one exception narrow (D105): only `token` in the query of GET /files/{fileId}/content, and only while that
// operation needs the session cookie and answers with `Referrer-Policy: no-referrer`. Everything else is still refused.
//
//   node --test tests/no-credentials-in-url.test.mjs     (part of npm test)
import { createRequire } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const rule = createRequire(import.meta.url)('../openapi/rules/noCredentialsInUrl.js');
const PATH = '/files/{fileId}/content';

/** A minimal contract with one operation: the content download as written in files.yaml unless `change` alters it. */
function contract(change = () => {}) {
  const op = {
    parameters: [{ name: 'token', in: 'query', required: true, schema: { type: 'string', maxLength: 512 } }],
    responses: {
      200: { description: 'The file.', headers: { 'Referrer-Policy': { schema: { type: 'string', const: 'no-referrer' } } } },
    },
  };
  const doc = { openapi: '3.1.0', security: [{ sessionCookie: [] }], paths: { [PATH]: { get: op } } };
  change(doc, op);
  return doc;
}

test('the download token on GET /files/{fileId}/content is allowed', () => {
  assert.deepEqual(rule(contract()), []);
});

test('the same name anywhere else is refused', () => {
  const other = contract((doc, op) => { doc.paths = { '/files/{fileId}/download-url': { get: op } }; });
  assert.equal(rule(other).length, 1);
  const post = contract((doc, op) => { doc.paths[PATH] = { post: op }; });
  assert.equal(rule(post).length, 1);
  const inPath = contract((doc, op) => { op.parameters[0].in = 'path'; });
  assert.equal(rule(inPath).length, 1);
});

test('another credential-like name on the excepted operation is refused', () => {
  const r = rule(contract((doc, op) => { op.parameters.push({ name: 'apiKey', in: 'query', schema: { type: 'string' } }); }));
  assert.equal(r.length, 1);
  assert.match(r[0].message, /apiKey/);
});

test('the exception needs the session cookie', () => {
  const r = rule(contract((doc, op) => { op.security = []; }));
  assert.equal(r.length, 1);
  assert.match(r[0].message, /session cookie/);
});

test('the exception needs Referrer-Policy: no-referrer on the 200', () => {
  const none = rule(contract((doc, op) => { delete op.responses[200].headers; }));
  assert.match(none[0].message, /Referrer-Policy/);
  const loose = rule(contract((doc, op) => { op.responses[200].headers['Referrer-Policy'].schema = { type: 'string', maxLength: 50 }; }));
  assert.match(loose[0].message, /Referrer-Policy/);
});

test('path-level and component parameters are checked too', () => {
  const pathLevel = contract((doc) => { doc.paths['/x'] = { parameters: [{ name: 'password', in: 'query' }], get: { responses: {} } }; });
  assert.equal(rule(pathLevel).length, 1);
  const component = contract((doc) => { doc.components = { parameters: { T: { name: 'accessToken', in: 'query' } } }; });
  assert.equal(rule(component).length, 1);
});
