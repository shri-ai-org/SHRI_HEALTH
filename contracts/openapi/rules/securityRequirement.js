'use strict';
// shri-security: non-public operations require the session cookie (or the AI delegated token); unsafe methods also require
// the CSRF header; public and partner-signed operations set security: [] (SECURITY_MODEL §1, §2.3).
const { operations, isObject } = require('./_lib.js');
const UNSAFE = ['post', 'put', 'patch', 'delete'];
module.exports = (doc) => {
  const out = [];
  for (const { method, op, at } of operations(doc)) {
    const perm = op['x-permission'];
    const sec = Array.isArray(op.security) ? op.security : doc.security;
    if (perm === 'public' || perm === 'partner-signed') {
      if (!Array.isArray(op.security) || op.security.length !== 0) out.push({ message: `"${perm}" operations must set security: [] explicitly.`, path: at });
      continue;
    }
    if (!Array.isArray(sec) || sec.length === 0) { out.push({ message: 'Operation has no security requirement.', path: at }); continue; }
    sec.forEach((req, i) => {
      if (!isObject(req)) return;
      const names = Object.keys(req);
      if (!names.includes('sessionCookie') && !names.includes('delegatedToken')) out.push({ message: 'Security must use sessionCookie (or delegatedToken for the AI gateway).', path: at.concat('security') });
      if (UNSAFE.includes(method) && names.includes('sessionCookie') && !names.includes('csrfHeader')) {
        out.push({ message: `${method.toUpperCase()} with the session cookie must also require csrfHeader: [{ sessionCookie: [], csrfHeader: [] }].`, path: Array.isArray(op.security) ? at.concat('security', i) : at });
      }
    });
  }
  return out;
};
