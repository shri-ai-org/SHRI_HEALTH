'use strict';
// owasp:api2:2023-no-credentials-in-url, redefined (CONTRACT_GOVERNANCE §5): a query or path parameter named like a
// credential puts that credential in URLs, which end up in logs, browser history and Referer headers (OWASP API2:2023).
// Same check and message as OWASP's rule, on real parameter lists only (its JSONPath also visits schema properties
// named `in` and crashes Spectral), with one documented exception.
//
// Exception (D105): GET /files/{fileId}/content takes the one-time download token in the query, because the browser
// follows the link as a plain download. It is not a credential on its own, and the rule still holds it to that: the
// operation must require the session cookie (the same user's session goes with the token) and its 200 must send
// `Referrer-Policy: no-referrer`. Core accepts the token once, for one user and one file, for about one minute, and
// the query string is never logged on this route. Any other parameter, path or method is still refused.
const { operations, isObject, deref } = require('./_lib.js');

const CREDENTIAL = /^.*(client_?secret|token|access_?token|refresh_?token|id_?token|password|secret|api-?key).*$/i;
const EXCEPTIONS = [
  { path: '/files/{fileId}/content', method: 'get', in: 'query', name: 'token', reason: 'D105 one-time download token' },
];

const message = (name) => `Security credentials detected in path parameter: ${name}.`;

function excepted(doc, path, method, op, param) {
  const e = EXCEPTIONS.find((x) => x.path === path && x.method === method && x.in === param.in && x.name === param.name);
  if (!e) return null;
  const security = Array.isArray(op.security) ? op.security : doc.security;
  const session = Array.isArray(security) && security.length > 0
    && security.every((s) => isObject(s) && 'sessionCookie' in s);
  const ok = deref(doc, op.responses && op.responses['200']);
  const headers = isObject(ok && ok.headers) ? ok.headers : {};
  const referrer = Object.entries(headers).find(([k]) => k.toLowerCase() === 'referrer-policy');
  const schema = referrer && deref(doc, deref(doc, referrer[1]).schema);
  const noReferrer = isObject(schema) && (schema.const === 'no-referrer'
    || (Array.isArray(schema.enum) && schema.enum.length === 1 && schema.enum[0] === 'no-referrer'));
  if (!session) return `${e.reason}: the exception for "${param.name}" needs the session cookie on every security requirement.`;
  if (!noReferrer) return `${e.reason}: the exception for "${param.name}" needs a 200 header Referrer-Policy fixed to no-referrer.`;
  return true;
}

module.exports = (doc) => {
  const out = [];
  const check = (list, at, ctx) => {
    if (!Array.isArray(list)) return;
    list.forEach((raw, i) => {
      const param = deref(doc, raw);
      if (!isObject(param) || !['query', 'path'].includes(param.in) || typeof param.name !== 'string') return;
      if (!CREDENTIAL.test(param.name)) return;
      const ex = ctx ? excepted(doc, ctx.path, ctx.method, ctx.op, param) : null;
      if (ex === true) return;
      out.push({ message: typeof ex === 'string' ? ex : message(param.name), path: at.concat(i, 'name') });
    });
  };
  // Path-level parameters apply to every operation under the path, so each is checked with each operation.
  for (const { path, method, op, item, at } of operations(doc)) {
    check(op.parameters, at.concat('parameters'), { path, method, op });
    check(item.parameters, ['paths', path, 'parameters'], { path, method, op });
  }
  const comp = isObject(doc && doc.components) && isObject(doc.components.parameters) ? doc.components.parameters : {};
  for (const [k, raw] of Object.entries(comp)) {
    const param = deref(doc, raw);
    if (isObject(param) && ['query', 'path'].includes(param.in) && typeof param.name === 'string' && CREDENTIAL.test(param.name)) {
      out.push({ message: message(param.name), path: ['components', 'parameters', k, 'name'] });
    }
  }
  return out.filter((r, i, all) => all.findIndex((x) => x.path.join('/') === r.path.join('/') && x.message === r.message) === i);
};
