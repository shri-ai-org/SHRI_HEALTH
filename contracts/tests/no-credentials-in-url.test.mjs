// The credentials-in-URL rule (owasp:api2:2023-no-credentials-in-url, redefined in openapi/rules/noCredentialsInUrl.js)
// keeps its one exception narrow (D105): only `token` in the query of GET /files/{fileId}/content (staff session cookie)
// and GET /portal/me/files/{fileId}/content (portal session cookie), and only while that operation needs its own session
// cookie and answers with `Referrer-Policy: no-referrer`. Everything else is still refused.
//
//   node --test tests/no-credentials-in-url.test.mjs     (part of npm test)
import { createRequire } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const rule = createRequire(import.meta.url)('../openapi/rules/noCredentialsInUrl.js');
const PATH = '/files/{fileId}/content';
const PORTAL_PATH = '/portal/me/files/{fileId}/content';

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

/** The portal's content download as written in portal.yaml, unless `change` alters it. */
function portalContract(change = () => {}) {
  const doc = contract((d, op) => {
    d.paths = { [PORTAL_PATH]: { get: op } };
    op.security = [{ portalSessionCookie: [] }];
  });
  change(doc, doc.paths[PORTAL_PATH].get);
  return doc;
}

test('the download token on GET /portal/me/files/{fileId}/content is allowed with the portal session', () => {
  assert.deepEqual(rule(portalContract()), []);
});

test('the portal exception needs the portal session cookie, never the staff one or none', () => {
  const staff = rule(portalContract((doc, op) => { op.security = [{ sessionCookie: [] }]; }));
  assert.equal(staff.length, 1);
  assert.match(staff[0].message, /portal session cookie/);
  const none = rule(portalContract((doc, op) => { op.security = []; }));
  assert.match(none[0].message, /portal session cookie/);
  const staffOnStaffPath = rule(contract((doc, op) => { op.security = [{ portalSessionCookie: [] }]; }));
  assert.equal(staffOnStaffPath.length, 1);
  assert.match(staffOnStaffPath[0].message, /session cookie/);
});

test('the portal exception needs Referrer-Policy: no-referrer and covers only that path, method and name', () => {
  const none = rule(portalContract((doc, op) => { delete op.responses[200].headers; }));
  assert.match(none[0].message, /Referrer-Policy/);
  const other = portalContract((doc, op) => { doc.paths = { '/portal/me/record-download-url': { get: op } }; });
  assert.equal(rule(other).length, 1);
  const post = portalContract((doc, op) => { doc.paths[PORTAL_PATH] = { post: op }; });
  assert.equal(rule(post).length, 1);
  const extra = rule(portalContract((doc, op) => { op.parameters.push({ name: 'password', in: 'query' }); }));
  assert.equal(extra.length, 1);
  assert.match(extra[0].message, /password/);
});
